targetScope = 'resourceGroup'

param appName string
param location string = resourceGroup().location
param tags object = {}
param environmentResourceId string
param registryEndpoint string
param identityResourceId string
param identityClientId string
param publicUrl string
param backendImage string
param apiClientId string
param connectorClientId string
@allowed(['certificate', 'managed-identity'])
param oboAuthMode string = 'certificate'
param signingKeyId string = ''
param certificateThumbprint string = ''

var credentialEnvironment = oboAuthMode == 'certificate' ? [
  { name: 'OBO_KEY_ID', value: signingKeyId }
  { name: 'OBO_CERTIFICATE_THUMBPRINT', value: certificateThumbprint }
] : []

module app 'br/public:avm/res/app/container-app:0.23.0' = {
  name: 'container-app'
  params: {
    name: appName
    location: location
    tags: union(tags, { 'azd-service-name': 'mcp' })
    environmentResourceId: environmentResourceId
    managedIdentities: { userAssignedResourceIds: [identityResourceId] }
    ingressExternal: true
    ingressAllowInsecure: false
    ingressTargetPort: 8080
    ingressTransport: 'http'
    activeRevisionsMode: 'Single'
    maxInactiveRevisions: 0
    workloadProfileName: 'Consumption'
    scaleSettings: { minReplicas: 1, maxReplicas: 1 }
    registries: [
      {
        server: registryEndpoint
        identity: identityResourceId
      }
    ]
    containers: [
      {
        name: 'mcp'
        image: backendImage
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: concat([
          { name: 'NODE_ENV', value: 'production' }
          { name: 'PORT', value: '8080' }
          { name: 'ENTRA_TENANT_ID', value: subscription().tenantId }
          { name: 'MCP_API_CLIENT_ID', value: apiClientId }
          { name: 'MCP_ALLOWED_CLIENT_IDS', value: connectorClientId }
          { name: 'MCP_PUBLIC_URL', value: publicUrl }
          { name: 'AZURE_CLIENT_ID', value: identityClientId }
          { name: 'OBO_AUTH_MODE', value: oboAuthMode }
        ], credentialEnvironment)
        probes: [
          {
            type: 'Liveness'
            httpGet: { path: '/health/live', port: 8080, scheme: 'HTTP' }
            initialDelaySeconds: 10
            periodSeconds: 30
          }
          {
            type: 'Readiness'
            httpGet: { path: '/health/ready', port: 8080, scheme: 'HTTP' }
            initialDelaySeconds: 5
            periodSeconds: 10
          }
          {
            type: 'Startup'
            httpGet: { path: '/health/live', port: 8080, scheme: 'HTTP' }
            periodSeconds: 5
            failureThreshold: 30
          }
        ]
      }
    ]
    enableTelemetry: false
  }
}
