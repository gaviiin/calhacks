#!/usr/bin/env bash
# Deploy Pit Wall to Azure Container Apps. Needs the Azure CLI, logged in (az login).
#
#   ./deploy/azure/deploy.sh                    # resource group pitwall-rg in westus3
#   RG=my-rg LOCATION=eastus2 ./deploy/azure/deploy.sh
#
# Optional, for the independent auditor on Azure OpenAI (granted by role, no key):
#   AOAI_ENDPOINT=https://<resource>.openai.azure.com AOAI_DEPLOYMENT=gpt-4.1-mini \
#   AOAI_RESOURCE_ID=$(az cognitiveservices account show -n <resource> -g <rg> --query id -o tsv) ./deploy/azure/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

RG=${RG:-pitwall-rg}
LOCATION=${LOCATION:-westus3}
SECRET=${PITWALL_SECRET:-$(openssl rand -hex 32)}

az group create -n "$RG" -l "$LOCATION" -o none
params=(pitwallSecret="$SECRET" azureOpenAiEndpoint="${AOAI_ENDPOINT:-}" azureOpenAiDeployment="${AOAI_DEPLOYMENT:-}"
        azureOpenAiResourceId="${AOAI_RESOURCE_ID:-}" anthropicApiKey="${ANTHROPIC_API_KEY:-}")

ACR_NAME=${ACR_NAME:-pitwallacr$(echo -n "$(az account show --query id -o tsv)$RG" | shasum | cut -c1-10)}

echo "1/2 build the image in Azure Container Registry ($ACR_NAME)"
az acr create -g "$RG" -n "$ACR_NAME" --sku Basic -o none
az acr build -r "$ACR_NAME" -t pitwall-api:latest -f deploy/azure/Dockerfile . -o none

echo "2/2 infrastructure and app (identity, Key Vault, logs, Application Insights, Container Apps)"
URL=$(az deployment group create -g "$RG" -f deploy/azure/main.bicep -p "${params[@]}" acrName="$ACR_NAME" \
      image="$ACR_NAME.azurecr.io/pitwall-api:latest" --query properties.outputs.url.value -o tsv)

echo
echo "Pit Wall is up: $URL"
echo "  curl -s $URL/api/microsoft/status"
echo "  curl -s -XPOST $URL/api/runs -H 'content-type: application/json' -d '{\"season\": 2024}'"
