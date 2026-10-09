targetScope = 'resourceGroup'

param name string
param location string = resourceGroup().location
param tags object = {}
param suffix string
param operatorObjectId string
param backendImage string
param apiClientId string
param connectorClientId string
@allowed(['certificate', 'managed-identity'])
param oboAuthMode string = 'certificate'
param signingKeyId string
param certificateThumbprint string

var appName = 'ca-${name}-${suffix}'

module logs 'br/public:avm/res/operational-insights/workspace:0.16.1' = {
  name: 'logs'
  params: {
    name: 'log-${name}-${suffix}'
    location: location
    tags: tags
    dataRetention: 30
    dailyQuotaGb: '0.5'
    forceCmkForQuery: false
    enableTelemetry: false
  }
}

module identity 'br/public:avm/res/managed-identity/user-assigned-identity:0.6.0' = {
  name: 'identity'
  params: {
    name: 'id-${name}-${suffix}'
    location: location
    tags: tags
    enableTelemetry: false
  }
}

module stack 'br/public:avm/ptn/azd/container-apps-stack:0.4.0' = {
  name: 'container-stack'
  params: {
    containerAppsEnvironmentName: 'cae-${name}-${suffix}'
    containerRegistryName: 'cr${replace(name, '-', '')}${suffix}'
    location: location
    tags: tags
    logAnalyticsWorkspaceName: logs.outputs.name
    acrSku: 'Basic'
    acrAdminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    zoneRedundant: false
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    enableTelemetry: false
  }
}

module vault 'br/public:avm/res/key-vault/vault:0.14.2' = {
  name: 'vault'
  params: {
    name: 'kv-mcp-${suffix}'
    location: location
    tags: tags
    sku: 'standard'
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 7
    enableVaultForDeployment: false
    enableVaultForTemplateDeployment: false
    enableVaultForDiskEncryption: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    roleAssignments: [
      {
        principalId: identity.outputs.principalId
        principalType: 'ServicePrincipal'
        roleDefinitionIdOrName: '12338af0-0e69-4776-bea7-57ae8d297424'
      }
      {
        principalId: operatorObjectId
        principalType: 'User'
        roleDefinitionIdOrName: 'a4417e6f-fecd-4de8-b567-7b0420556985'
      }
    ]
    diagnosticSettings: [
      {
        name: 'audit'
        workspaceResourceId: logs.outputs.resourceId
        logCategoriesAndGroups: [{ categoryGroup: 'audit' }]
      }
    ]
    enableTelemetry: false
  }
}

module pull './registry-pull.bicep' = {
  name: 'registry-pull'
  params: {
    name: stack.outputs.registryName
    location: location
    tags: tags
    principalId: identity.outputs.principalId
  }
}

var publicUrl = 'https://${appName}.${stack.outputs.defaultDomain}/mcp'

module app './mcp-app.bicep' = if (!empty(backendImage)) {
  name: 'mcp-app'
  params: {
    appName: appName
    location: location
    tags: tags
    environmentResourceId: stack.outputs.environmentResourceId
    registryEndpoint: stack.outputs.registryLoginServer
    identityResourceId: identity.outputs.resourceId
    identityClientId: identity.outputs.clientId
    publicUrl: publicUrl
    backendImage: backendImage
    apiClientId: apiClientId
    connectorClientId: connectorClientId
    oboAuthMode: oboAuthMode
    signingKeyId: signingKeyId
    certificateThumbprint: certificateThumbprint
  }
  dependsOn: [pull, vault]
}

output registryName string = stack.outputs.registryName
output registryEndpoint string = stack.outputs.registryLoginServer
output appName string = appName
output vaultName string = vault.outputs.name
output identityClientId string = identity.outputs.clientId
output workspaceId string = logs.outputs.logAnalyticsWorkspaceId
output publicUrl string = publicUrl
