targetScope = 'subscription'

@minLength(3)
@maxLength(20)
param environmentName string
param location string
param operatorObjectId string
param backendImage string = ''
param apiClientId string = ''
param connectorClientId string = ''
@allowed(['certificate', 'managed-identity'])
param oboAuthMode string = 'certificate'
param signingKeyId string = ''
param certificateThumbprint string = ''

var suffix = take(uniqueString(subscription().id, environmentName, location), 6)
var tags = {
  'azd-env-name': environmentName
  project: 'copilot-credit-management-mcp'
}

resource group 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: 'rg-${environmentName}-${suffix}'
  location: location
  tags: tags
}

module resources './modules/resources.bicep' = {
  name: 'mcp-resources-${environmentName}'
  scope: group
  params: {
    name: environmentName
    location: location
    tags: tags
    suffix: suffix
    operatorObjectId: operatorObjectId
    backendImage: backendImage
    apiClientId: apiClientId
    connectorClientId: connectorClientId
    oboAuthMode: oboAuthMode
    signingKeyId: signingKeyId
    certificateThumbprint: certificateThumbprint
  }
}

output AZURE_RESOURCE_GROUP string = group.name
output AZURE_CONTAINER_REGISTRY_NAME string = resources.outputs.registryName
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.registryEndpoint
output AZURE_CONTAINER_APP_NAME string = resources.outputs.appName
output AZURE_KEY_VAULT_NAME string = resources.outputs.vaultName
output AZURE_CLIENT_ID string = resources.outputs.identityClientId
output AZURE_LOG_ANALYTICS_WORKSPACE_ID string = resources.outputs.workspaceId
output MCP_PUBLIC_URL string = resources.outputs.publicUrl
output MCP_API_CLIENT_ID string = apiClientId
output MCP_ALLOWED_CLIENT_IDS string = connectorClientId
output OBO_AUTH_MODE string = oboAuthMode
output OBO_KEY_ID string = signingKeyId
output OBO_CERTIFICATE_THUMBPRINT string = certificateThumbprint
