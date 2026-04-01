# Deployment Guide — CI/CD Pipeline & Cloud Infrastructure

This guide covers deploying the AI Sandbox Chat stack — the Next.js frontend, the llama.cpp LLM server, and the shared sandbox volume — into a cloud environment via a CI/CD pipeline.

---

## Deployment Architecture

```
                          ┌──────────────────────────────────┐
                          │         Cloud Load Balancer       │
                          │        (HTTPS termination)        │
                          └──────────┬───────────────────────┘
                                     │
                    ┌────────────────┼────────────────────┐
                    │                │                     │
                    ▼                ▼                     ▼
          ┌──────────────┐  ┌──────────────┐    ┌──────────────┐
          │  Next.js App  │  │  Next.js App  │    │  (scale out) │
          │  Container    │  │  Container    │    │              │
          │  Port 3000    │  │  Port 3000    │    │              │
          └──────┬────────┘  └──────┬────────┘    └──────────────┘
                 │                  │
                 ▼                  ▼
          ┌─────────────────────────────────┐
          │     Internal Service Mesh        │
          └──────────────┬──────────────────┘
                         │
                         ▼
          ┌─────────────────────────────────┐
          │     llama.cpp Server             │
          │     Container (GPU)              │
          │     Port 8080                    │
          │     Bonsai-8B.gguf              │
          │     1× GPU (NVIDIA T4/L4/A10G)  │
          └──────────────┬──────────────────┘
                         │
                         ▼
          ┌─────────────────────────────────┐
          │     Persistent Volume            │
          │     /sandbox (shared)            │
          └─────────────────────────────────┘
```

---

## Cloud Spec Requirements

Given that Bonsai-8B.gguf at Q1 quantization is only **~1.13 GB**, the hardware requirements are extremely modest for a GPU-accelerated LLM workload.

### Minimum Specs

| Component | Spec | Cloud Instance | Est. Monthly Cost |
|-----------|------|----------------|-------------------|
| **LLM Server** | 4 vCPU, 16 GB RAM, 1× NVIDIA T4 (16 GB) | AWS `g4dn.xlarge` / Azure `NC4as_T4_v3` / GCP `n1-standard-4` + T4 | ~$380–530 |
| **Next.js App** | 2 vCPU, 4 GB RAM, no GPU | AWS `t3.medium` / Azure `B2s` / GCP `e2-medium` | ~$30–40 |
| **Sandbox Storage** | 10 GB SSD persistent volume | EBS / Azure Disk / GCP PD | ~$1–2 |

### Recommended Specs (Production)

| Component | Spec | Cloud Instance | Est. Monthly Cost |
|-----------|------|----------------|-------------------|
| **LLM Server** | 4 vCPU, 24 GB RAM, 1× NVIDIA L4 (24 GB) | AWS `g6.xlarge` / GCP `g2-standard-4` | ~$450–600 |
| **Next.js App** | 2× containers, 2 vCPU, 4 GB each | ECS Fargate / Cloud Run / AKS | ~$50–80 |
| **Sandbox Storage** | 50 GB SSD with daily snapshots | Managed disk | ~$5–10 |
| **Load Balancer** | ALB / Application Gateway / Cloud LB | Managed LB | ~$20–30 |
| **Total** | | | **~$525–720/month** |

### Budget Option (Spot/Preemptible GPU)

For non-critical or dev environments, use spot GPU instances:

| Provider | Instance | Spot Price (est.) |
|----------|----------|-------------------|
| AWS | `g4dn.xlarge` spot | ~$150–190/month |
| GCP | `n1-standard-4` + T4 preemptible | ~$120–170/month |
| Azure | `NC4as_T4_v3` spot | ~$140–180/month |

> **Total with spot GPU: ~$180–250/month** for the entire stack.

---

## Container Images

### Dockerfile — Next.js Frontend

```dockerfile
# ── Build Stage ──────────────────────────────────────────
FROM node:18-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Runtime Stage ────────────────────────────────────────
FROM node:18-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV AI_BASE_URL=http://llm-server:8080

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Sandbox volume mount point
RUN mkdir -p /app/sandbox
VOLUME /app/sandbox

EXPOSE 3000
CMD ["node", "server.js"]
```

### Dockerfile — llama.cpp LLM Server

```dockerfile
FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y \
    build-essential cmake git curl \
    && rm -rf /var/lib/apt/lists/*

# Build llama.cpp with CUDA
RUN git clone https://github.com/nicholasgriffintn/llama.cpp-prism.git /llama.cpp \
    && cd /llama.cpp \
    && cmake -B build -DGGML_CUDA=ON \
    && cmake --build build --config Release -j$(nproc)

WORKDIR /llama.cpp

# Model will be mounted or downloaded at runtime
VOLUME /models

EXPOSE 8080

CMD ["./build/bin/llama-server", \
     "-m", "/models/Bonsai-8B.gguf", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "-ngl", "99", \
     "-c", "33792"]
```

---

## Docker Compose (Local Testing)

```yaml
version: "3.8"

services:
  llm-server:
    build:
      context: ./docker/llm
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    volumes:
      - ./models:/models
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

  web:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - AI_BASE_URL=http://llm-server:8080
    volumes:
      - sandbox-data:/app/sandbox
    depends_on:
      - llm-server

volumes:
  sandbox-data:
```

```bash
docker compose up --build
```

---

## CI/CD Pipeline

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Build & Deploy

on:
  push:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_PREFIX: ${{ github.repository }}

jobs:
  # ── Build & Push Container Images ─────────────────────
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    strategy:
      matrix:
        include:
          - name: web
            context: .
            dockerfile: Dockerfile
          - name: llm-server
            context: ./docker/llm
            dockerfile: Dockerfile

    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v5
        with:
          context: ${{ matrix.context }}
          file: ${{ matrix.context }}/${{ matrix.dockerfile }}
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}-${{ matrix.name }}:latest
            ${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}-${{ matrix.name }}:${{ github.sha }}

  # ── Deploy to Kubernetes ──────────────────────────────
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        uses: azure/k8s-set-context@v4
        with:
          kubeconfig: ${{ secrets.KUBE_CONFIG }}

      - name: Update image tags
        run: |
          cd k8s/
          kustomize edit set image \
            web=${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}-web:${{ github.sha }} \
            llm-server=${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}-llm-server:${{ github.sha }}

      - name: Apply manifests
        run: kubectl apply -k k8s/

      - name: Wait for rollout
        run: |
          kubectl rollout status deployment/web -n ai-sandbox --timeout=300s
          kubectl rollout status deployment/llm-server -n ai-sandbox --timeout=600s
```

---

## Kubernetes Manifests

### Namespace & Persistent Volume

```yaml
# k8s/namespace.yml
apiVersion: v1
kind: Namespace
metadata:
  name: ai-sandbox
---
# k8s/pvc.yml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sandbox-pvc
  namespace: ai-sandbox
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 10Gi
  storageClassName: gp3  # AWS EBS gp3 / adjust for your cloud
```

### LLM Server Deployment

```yaml
# k8s/llm-server.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: llm-server
  namespace: ai-sandbox
spec:
  replicas: 1  # Single GPU instance
  selector:
    matchLabels:
      app: llm-server
  template:
    metadata:
      labels:
        app: llm-server
    spec:
      containers:
        - name: llm-server
          image: ghcr.io/your-org/ai-sandbox-chat-llm-server:latest
          ports:
            - containerPort: 8080
          resources:
            limits:
              nvidia.com/gpu: 1
              memory: "16Gi"
              cpu: "4"
            requests:
              nvidia.com/gpu: 1
              memory: "8Gi"
              cpu: "2"
          volumeMounts:
            - name: models
              mountPath: /models
          readinessProbe:
            httpGet:
              path: /v1/models
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: models-pvc
      nodeSelector:
        nvidia.com/gpu.present: "true"
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
---
apiVersion: v1
kind: Service
metadata:
  name: llm-server
  namespace: ai-sandbox
spec:
  selector:
    app: llm-server
  ports:
    - port: 8080
      targetPort: 8080
```

### Next.js Web Deployment

```yaml
# k8s/web.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: ai-sandbox
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: ghcr.io/your-org/ai-sandbox-chat-web:latest
          ports:
            - containerPort: 3000
          env:
            - name: AI_BASE_URL
              value: "http://llm-server:8080"
          resources:
            limits:
              memory: "1Gi"
              cpu: "1"
            requests:
              memory: "512Mi"
              cpu: "250m"
          volumeMounts:
            - name: sandbox
              mountPath: /app/sandbox
          readinessProbe:
            httpGet:
              path: /
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 5
      volumes:
        - name: sandbox
          persistentVolumeClaim:
            claimName: sandbox-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: ai-sandbox
spec:
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 3000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: ai-sandbox
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts: [ai-sandbox.yourdomain.com]
      secretName: web-tls
  rules:
    - host: ai-sandbox.yourdomain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

---

## Cloud Provider Quick-Start

### AWS (EKS + g4dn)

```bash
# 1. Create EKS cluster with GPU node group
eksctl create cluster --name ai-sandbox --region us-east-1 \
  --nodegroup-name gpu --node-type g4dn.xlarge --nodes 1 \
  --managed --gpu

# 2. Install NVIDIA device plugin
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.14.0/nvidia-device-plugin.yml

# 3. Install ingress + cert-manager
helm install ingress-nginx ingress-nginx/ingress-nginx
helm install cert-manager jetstack/cert-manager --set installCRDs=true

# 4. Deploy
kubectl apply -k k8s/
```

### GCP (GKE + T4)

```bash
# 1. Create GKE cluster with GPU node pool
gcloud container clusters create ai-sandbox \
  --zone us-central1-a --num-nodes 1 --machine-type n1-standard-4

gcloud container node-pools create gpu-pool \
  --cluster ai-sandbox --zone us-central1-a \
  --machine-type n1-standard-4 --accelerator type=nvidia-tesla-t4,count=1 \
  --num-nodes 1

# 2. Install NVIDIA drivers
kubectl apply -f https://raw.githubusercontent.com/GoogleCloudPlatform/container-engine-accelerators/master/nvidia-driver-installer/cos/daemonset-preloaded.yaml

# 3. Deploy
kubectl apply -k k8s/
```

### Azure (AKS + NC-series)

```bash
# 1. Create AKS cluster with GPU node pool
az aks create --resource-group ai-sandbox --name ai-sandbox \
  --node-count 1 --node-vm-size Standard_NC4as_T4_v3

# 2. Install NVIDIA device plugin
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.14.0/nvidia-device-plugin.yml

# 3. Deploy
kubectl apply -k k8s/
```

---

## Serverless Alternative (No Kubernetes)

For simpler deployments without Kubernetes:

| Component | Platform | Notes |
|-----------|----------|-------|
| **Next.js** | Vercel / AWS App Runner / Cloud Run | Set `AI_BASE_URL` env var to point at LLM server |
| **llama.cpp** | RunPod / Vast.ai / Lambda Cloud | Cheapest GPU rental; expose port 8080 |
| **Sandbox** | S3 / GCS bucket mounted via FUSE | Replace local filesystem ops with cloud storage |

```
Vercel (web) → RunPod (llm-server) → S3 (sandbox)
   $0–20/mo       $75–150/mo          $0.50/mo

Total: ~$75–170/month
```

---

## Security Considerations for Production

1. **Network**: LLM server should NOT be publicly accessible — keep it on an internal service mesh / private subnet
2. **Auth**: Add authentication middleware to the Next.js app (e.g. NextAuth.js, Clerk)
3. **Sandbox isolation**: In multi-tenant scenarios, give each user a separate sandbox volume or S3 prefix
4. **Rate limiting**: Add rate limiting to `/api/chat` to prevent abuse of GPU resources
5. **HTTPS**: Terminate TLS at the load balancer / ingress
6. **Model downloads**: Store model files in a private object storage bucket, not in the container image

---

## Pipeline Summary

```
Developer pushes to main
        │
        ▼
┌─────────────────────────────┐
│  GitHub Actions              │
│  1. Build web container      │
│  2. Build llm-server image   │
│  3. Push to GHCR             │
│  4. kubectl apply to cluster │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  Kubernetes Cluster          │
│  • web (2 replicas, no GPU)  │
│  • llm-server (1 replica,    │
│    1× NVIDIA T4/L4 GPU)     │
│  • sandbox PVC (10 GB SSD)   │
│  • Ingress + TLS             │
└─────────────────────────────┘
```
