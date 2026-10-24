// Pit Wall on Azure Container Apps: one container, managed identity, secrets in Key Vault, telemetry in Application Insights.
//
//   az group create -n pitwall-rg -l westus3
//   az deployment group create -g pitwall-rg -f deploy/azure/main.bicep \
//     -p image=<acr>.azurecr.io/pitwall-api:latest pitwallSecret=$(openssl rand -hex 32)
//
// See deploy/azure/README.md for the full walkthrough (deploy.sh does all of it).

@description('Short name used for every resource.')
param name string = 'pitwall'

param location string = resourceGroup().location

@description('Container image. Leave the default for the first deploy; deploy.sh builds and pushes the real one.')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'

@secure()
@description('Signs approval links and webhooks.')
param pitwallSecret string

@secure()
@description('Optional: Claude for the preparer agent (PITWALL_AGENT=claude). Empty keeps the scripted agent.')
param anthropicApiKey string = ''

@description('Optional: Azure OpenAI endpoint for the independent auditor, e.g. https://<resource>.openai.azure.com')
param azureOpenAiEndpoint string = ''

@description('Optional: Azure OpenAI deployment name for the auditor.')
param azureOpenAiDeployment string = ''

@description('Optional: resource ID of the Azure OpenAI account, to grant the app identity "Cognitive Services OpenAI User" (no API key).')
param azureOpenAiResourceId string = ''

@description('Container registry name (deploy.sh creates it first so the image can be built before the app starts).')
param acrName string = take('${name}acr${uniqueString(resourceGroup().id)}', 50)

@description('Notification mode: dry (render only), live, off.')
@allowed(['dry', 'live', 'off'])
param notifyMode string = 'dry'

var suffix = uniqueString(resourceGroup().id)
var kvName = take('${name}kv${suffix}', 24)

// ----------------------------------------------------------------------------- identity, registry, secrets, logs

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-id'
  location: location
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, 'acrpull')
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, identity.id, 'kvsecretsuser')
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource secretPitwall 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'pitwall-secret'
  properties: { value: pitwallSecret }
}

resource secretAnthropic 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(anthropicApiKey)) {
  parent: kv
  name: 'anthropic-api-key'
  properties: { value: anthropicApiKey }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${name}-logs'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${name}-ai'
  location: location
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id }
}

// Azure OpenAI by role, not by key: the auditor gets a token for its managed identity.
module openAiRole 'openai-role.bicep' = if (!empty(azureOpenAiResourceId)) {
  name: 'openai-role'
  scope: resourceGroup(split(azureOpenAiResourceId, '/')[2], split(azureOpenAiResourceId, '/')[4])
  params: {
    accountName: last(split(azureOpenAiResourceId, '/'))
    principalId: identity.properties.principalId
  }
}

// ----------------------------------------------------------------------------- the app

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}

var kvSecrets = concat(
  [{ name: 'pitwall-secret', keyVaultUrl: secretPitwall.properties.secretUri, identity: identity.id }],
  empty(anthropicApiKey) ? [] : [{ name: 'anthropic-api-key', keyVaultUrl: secretAnthropic.properties.secretUri, identity: identity.id }])

var secretEnv = concat(
  [{ name: 'PITWALL_SECRET', secretRef: 'pitwall-secret' }],
  empty(anthropicApiKey) ? [] : [{ name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }, { name: 'PITWALL_AGENT', value: 'claude' }])

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${name}-api'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  dependsOn: [acrPull, kvSecretsUser]
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: { external: true, targetPort: 8000, transport: 'auto', allowInsecure: false }
      registries: startsWith(image, acr.properties.loginServer) ? [{ server: acr.properties.loginServer, identity: identity.id }] : []
      secrets: kvSecrets
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(secretEnv, [
            { name: 'PORT', value: '8000' }
            { name: 'PITWALL_NOTIFY', value: notifyMode }
            { name: 'PITWALL_MS_AUTH', value: 'managed_identity' }
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
            { name: 'AZURE_OPENAI_ENDPOINT', value: azureOpenAiEndpoint }
            { name: 'AZURE_OPENAI_DEPLOYMENT', value: azureOpenAiDeployment }
          ])
          volumeMounts: [{ volumeName: 'data', mountPath: '/app/data' }]
        }
      ]
      // One replica: each run's ledger is a SQLite file. The production step is Azure Database for PostgreSQL
      // (see docs/microsoft/PATH_TO_PRODUCTION.md), after which this can scale out.
      scale: { minReplicas: 1, maxReplicas: 1 }
      volumes: [{ name: 'data', storageType: 'EmptyDir' }]
    }
  }
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output acrLoginServer string = acr.properties.loginServer
output keyVault string = kv.name
output identityClientId string = identity.properties.clientId
