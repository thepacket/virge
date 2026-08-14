# VIRGE is a pure client-side app: the build produces static files and nginx
# serves them. There is no server component, and deliberately no place to put
# an API key — the assistant's key is entered in the browser and stays there.

FROM node:22-alpine AS build
WORKDIR /app

# Copy the manifests first so the dependency layer is cached across source edits.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
