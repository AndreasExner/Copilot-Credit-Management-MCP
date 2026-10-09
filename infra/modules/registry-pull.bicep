targetScope = 'resourceGroup'

param name string
@description('Interface compatibility; role assignments do not have a location.')
#disable-next-line no-unused-params
param location string = resourceGroup().location
@description('Interface compatibility; role assignments do not support tags.')
#disable-next-line no-unused-params
param tags object = {}
param principalId string

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: name
}

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, principalId, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
