targetScope = 'resourceGroup'

param appName string
param environmentName string
param registryName string
param identityName string
param backendImage string
param apiClientId string
param connectorClientId string
param location string = resourceGroup().location
@allowed(['certificate', 'managed-identity'])
param oboAuthMode string = 'managed-identity'
param signingKeyId string = ''
param certificateThumbprint string = ''

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: environmentName
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

var publicUrl = 'https://${appName}.${environment.properties.defaultDomain}/mcp'

module app './modules/mcp-app.bicep' = {
  name: 'mcp-app'
  params: {
    appName: appName
    location: location
    tags: resourceGroup().tags
    environmentResourceId: environment.id
    registryEndpoint: registry.properties.loginServer
    identityResourceId: identity.id
    identityClientId: identity.properties.clientId
    publicUrl: publicUrl
    backendImage: backendImage
    apiClientId: apiClientId
    connectorClientId: connectorClientId
    oboAuthMode: oboAuthMode
    signingKeyId: signingKeyId
    certificateThumbprint: certificateThumbprint
  }
}

output MCP_PUBLIC_URL string = publicUrl
output AZURE_CONTAINER_APP_NAME string = appName
