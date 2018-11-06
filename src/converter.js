const {
  GraphQLObjectType, GraphQLString, GraphQLInt, GraphQLNonNull, GraphQLUnionType,
  GraphQLInputObjectType, GraphQLFloat, GraphQLList, GraphQLBoolean, GraphQLEnumType
} = require('graphql');
const isEmpty = require('lodash/isEmpty');
const keyBy = require('lodash/keyBy');
const mapValues = require('lodash/mapValues');
const map = require('lodash/map');
const omitBy = require('lodash/omitBy');
const includes = require('lodash/includes');
const uppercamelcase = require('uppercamelcase');
const camelcase = require('camelcase');
const escodegen = require('escodegen');
const validators = require('./error-handling');

const INPUT_SUFFIX = 'In';
const DEFINITION_PREFIX = 'Definition';
const DROP_ATTRIBUTE_MARKER = Symbol('A marker to drop the attributes');

const referencePrefix = '#/definitions/';
function getItemTypeName (typeName, buildingInputType) {
  return uppercamelcase(`${typeName}${buildingInputType ? INPUT_SUFFIX : ''}`);
}
function getReferenceName (referenceName, buildingInputType) {
  return referenceName.startsWith(referencePrefix)
    ? getItemTypeName(`${DEFINITION_PREFIX}.${referenceName.split(referencePrefix)[1]}`, buildingInputType)
    : referenceName;
}

function mapBasicAttributeType (type, attributeName) {
  switch (type) {
    case 'string': return GraphQLString;
    case 'integer': return GraphQLInt;
    case 'number': return GraphQLFloat;
    case 'boolean': return GraphQLBoolean;
    default: throw new Error(`A JSON Schema attribute type ${type} on attribute ${attributeName} does not have a known GraphQL mapping`);
  }
}

function toSafeEnumKey (value) {
  if (/^[0-9]/.test(value)) {
    value = 'VALUE_' + value;
  }

  switch (value) {
    case '<': return 'LT';
    case '<=': return 'LTE';
    case '>=': return 'GTE';
    case '>': return 'GT';
    default:
      return value.replace(/[^_a-zA-Z0-9]/g, '_');
  }
}

function buildEnumType (context, attributeName, enumValues) {
  const enumName = uppercamelcase(attributeName);
  const graphqlToJsonMap = keyBy(enumValues, toSafeEnumKey);

  context.enumMaps.set(attributeName, graphqlToJsonMap);
  const enumType = new GraphQLEnumType({
    name: enumName,
    values: mapValues(graphqlToJsonMap, function (value) {
      return {value};
    })
  });

  context.enumTypes.set(attributeName, enumType);
  return enumType;
}

// Handles any custom object types fields. It will map on all the properties of the object with
// mapType to match to the corresponding graphql type. It also handles the required/nonNull types
function getObjectFields (context, schema, typeName, buildingInputType) {
  if (isEmpty(schema.properties)) {
    return {
      _typesWithoutFieldsAreNotAllowed_: {
        type: GraphQLString
      }
    };
  }
  return omitBy(
    mapValues(schema.properties, function (attributeDefinition, attributeName) {
      const qualifiedAttributeName = `${typeName}.${attributeName}`;
      const type = mapType(context, attributeDefinition, qualifiedAttributeName, buildingInputType);

      const modifiedType = includes(schema.required, attributeName) ? GraphQLNonNull(type) : type;
      return {type: modifiedType};
    }),
    {type: DROP_ATTRIBUTE_MARKER}
  );
}

// Matches any json schema type to the graphql corresponding type (including recursive types)
function mapType (context, attributeDefinition, attributeName, buildingInputType) {
  if (attributeDefinition.type === 'array') {
    const itemName = attributeDefinition.items.$ref ? attributeName : `${attributeName}Item`;
    const elementType = mapType(context, attributeDefinition.items, itemName, buildingInputType);
    if (elementType === DROP_ATTRIBUTE_MARKER) {
      return DROP_ATTRIBUTE_MARKER;
    }
    return GraphQLList(GraphQLNonNull(elementType));
  }

  if (attributeDefinition.type === 'object') {
    const name = getItemTypeName(attributeName, buildingInputType);
    // getFields need to be called lazily, since some types might not be available at the creation of
    // the object (with circular refs for instance)
    return buildingInputType
      ? new GraphQLInputObjectType({
        name,
        fields: () => getObjectFields(context, attributeDefinition, attributeName, buildingInputType)
      })
      : new GraphQLObjectType({
        name,
        fields: () => getObjectFields(context, attributeDefinition, attributeName, buildingInputType)
      });
    // return objectFromSchema(context, attributeDefinition, attributeName, buildingInputType);
  }
  const enumValues = attributeDefinition.enum;
  if (enumValues) {
    if (attributeDefinition.type !== 'string') {
      throw new Error(`The attribute ${attributeName} not supported because only conversion of string based enumertions are implemented`);
    }

    const existingEnum = context.enumTypes.get(attributeName);
    if (existingEnum) {
      return existingEnum;
    }

    return buildEnumType(context, attributeName, enumValues);
  }

  const typeReference = attributeDefinition.$ref;
  if (typeReference) {
    const typeReferenceName = getReferenceName(typeReference, buildingInputType);
    const typeMap = buildingInputType ? context.inputs : context.types;
    const referencedType = typeMap.get(typeReferenceName);
    if (!referencedType) {
      if (context.types.get(typeReferenceName) instanceof GraphQLUnionType && buildingInputType) {
        return DROP_ATTRIBUTE_MARKER;
      }
      throw new UnknownTypeReference(`The referenced type ${typeReferenceName} (${buildingInputType}) is unknown in ${attributeName}`);
    }
    return referencedType;
  }

  return mapBasicAttributeType(attributeDefinition.type, attributeName);
}

function registerDefinitionTypes (context, schema, buildingInputType) {
  if (schema.definitions) {
    validators.validateDefinitions(schema.definitions);
    const typeMap = buildingInputType ? context.inputs : context.types;
    mapValues(schema.definitions, function (definition, definitionName) { // MH {definitionName: definition}
      const itemName = uppercamelcase(`${DEFINITION_PREFIX}.${definitionName}`); // MH takes away _ - . Example: DefinitionTrick
      typeMap.set(getItemTypeName(itemName, buildingInputType), mapType(context, definition, itemName, buildingInputType)); // MH adds map value in context ... => ...
    }); // MH buildingInputType is undefined first time, then true the second time
  } // MH typeMap.set('typeName OR typeNameIn', '')
}

function buildRootType (context, typeName, schema) {
  registerDefinitionTypes(context, schema);
  registerDefinitionTypes(context, schema, true);
  const output = mapType(context, schema, typeName);
  const input = mapType(context, schema, typeName, true);

  return {input, output};
}

function buildUnionType (context, typeName, schema) {
  const output = new GraphQLUnionType({
    name: typeName,
    types: () => {
      return map(schema.switch, function (switchCase, caseIndex) {
        return mapType(context, switchCase.then, `${typeName}.switch[${caseIndex}]`);
      });
    }
  });

  // There are no input union types in GraphQL
  // https://github.com/facebook/graphql/issues/488
  return {output, input: undefined};
}

function convert (context, schema) {
  const typeName = schema.id ? schema.id : schema['$id'];
  validators.validateTopLevelId(typeName, schema);

  const typeBuilder = schema.switch ? buildUnionType : buildRootType; // MH if it has a switch key or not. Mine use buildRootType
  const {input, output} = typeBuilder(context, typeName, schema);

  context.types.set(typeName, output);
  if (input) {
    context.inputs.set(typeName, input);
  }

  return {output, input};
}

function newContext () {
  return {
    types: new Map(),
    inputs: new Map(),
    enumTypes: new Map(),
    enumMaps: new Map()
  };
}

class UnknownTypeReference extends Error {
  constructor (message) {
    super(message);
    this.name = 'UnknownTypeReference';
  }
}

function getConvertEnumFromGraphQLCode (context, attributePath) {
  const valueMap = context.enumMaps.get(attributePath);

  const cases = map(valueMap, function (jsonValue, graphQlValue) {
    return {
      type: 'SwitchCase',
      test: {type: 'Literal', value: graphQlValue},
      consequent: [{
        type: 'ReturnStatement',
        argument: {type: 'Literal', value: jsonValue}
      }]
    };
  });

  const functionName = camelcase(`convert${attributePath}FromGraphQL`);

  const valueIdentifier = { type: 'Identifier', name: 'value' };
  return escodegen.generate({
    type: 'FunctionDeclaration',
    id: { type: 'Identifier', name: functionName },
    params: [ valueIdentifier ],
    body: {
      type: 'BlockStatement',
      body: [ {
        type: 'SwitchStatement',
        discriminant: valueIdentifier,
        cases
      }]
    }
  });
}

module.exports = {
  INPUT_SUFFIX,
  UnknownTypeReference,
  newContext,
  convert,
  getConvertEnumFromGraphQLCode
};
