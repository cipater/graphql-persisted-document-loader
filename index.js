const vm = require('vm')
const os = require('os')
const loaderUtils = require('loader-utils')
const { GraphQLError, visit, Kind, separateOperations } = require('graphql')
const { operationHash, operationRegistrySignature } = require('apollo-graphql')

module.exports = function graphQLPersistedDocumentLoader(
  graphQLTagLoaderSource
) {
  const context = this
  const options = loaderUtils.getOptions(this) || {}
  const { document, dependencies } = getDocumentAndDependenciesFromSource(
    graphQLTagLoaderSource,
    context
  )

  this._module._graphQLDocuments = [document]

  const callback = this.async()

  // Wait for dependencies (if any) to resolve so we can merge the aggregated
  // ... documents and hash the "printed" results of the AST
  Promise.all(dependencies)
    .then(modules => {
      // collect the documents from dependencies
      modules.map(mod => {
        this._module._graphQLDocuments = this._module._graphQLDocuments.concat(
          mod.module._graphQLDocuments
        )
      })

      const operations = mergedOperationsAndFragments(
        this._module._graphQLDocuments
      )

      for (let [operationName, operationAST] of Object.entries(operations)) {
        if (options.addTypename)
          operationAST = withTypenameFieldAddedWhereNeeded(operationAST)

        const printed = operationRegistrySignature(
          operationAST,
          operationName,
          {
            preserveStringAndNumericLiterals:
              options.preserveStringAndNumericLiterals
          }
        )

        const id = JSON.stringify(operationHash(printed))

        graphQLTagLoaderSource += `${os.EOL}module.exports["${operationName}"].documentId = ${id};`
      }

      callback(null, graphQLTagLoaderSource)
    })
    .catch(err => {
      console.log('error', err)
      callback(err)
    })
}

function getDocumentAndDependenciesFromSource(source, context) {
  const dependencies = []
  const sandbox = {
    require(file) {
      dependencies.push(
        new Promise((resolve, reject) => {
          context.loadModule(file, (err, source, sourceMap, module) => {
            if (err) {
              reject(err)
            } else {
              resolve({ source, sourceMap, module })
            }
          })
        })
      )
      return { definitions: [] }
    },
    module: {
      exports: null
    }
  }

  // Run the graphql-tag loader generated code to capture the dependencies.
  vm.runInNewContext(source, sandbox)

  return { document: sandbox.module.exports, dependencies }
}

function mergedOperationsAndFragments(documents) {
  return separateOperations({
    kind: Kind.DOCUMENT,
    definitions: [
      ...Object.values(fragments(documents)),
      ...Object.values(operations(documents))
    ]
  })
}

function fragments(documents) {
  const fragments = Object.create(null)

  for (const document of documents) {
    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        fragments[definition.name.value] = definition
      }
    }
  }

  return fragments
}

function operations(documents) {
  const operations = Object.create(null)

  for (const document of documents) {
    for (const definition of document.definitions) {
      if (definition.kind === Kind.OPERATION_DEFINITION) {
        if (!definition.name) {
          throw new GraphQLError(
            'Apollo does not support anonymous operations',
            [definition]
          )
        }
        operations[definition.name.value] = definition
      }
    }
  }

  return operations
}

const typenameField = {
  kind: Kind.FIELD,
  name: { kind: Kind.NAME, value: '__typename' }
}

function withTypenameFieldAddedWhereNeeded(ast) {
  return visit(ast, {
    enter: {
      SelectionSet(node) {
        return {
          ...node,
          selections: node.selections.filter(
            selection =>
              !(
                selection.kind === 'Field' &&
                selection.name.value === '__typename'
              )
          )
        }
      }
    },
    leave(node) {
      if (!(node.kind === 'Field' || node.kind === 'FragmentDefinition'))
        return undefined
      if (!node.selectionSet) return undefined

      return {
        ...node,
        selectionSet: {
          ...node.selectionSet,
          selections: [typenameField, ...node.selectionSet.selections]
        }
      }
    }
  })
}
