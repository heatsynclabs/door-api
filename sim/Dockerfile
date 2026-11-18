# The Open Access board simulator as a container, for docker-compose.staging.yml.
# No dependencies beyond Node itself.
FROM node:22-alpine
WORKDIR /sim
COPY arduino-openaccess.mjs ./
USER node
EXPOSE 9099
CMD ["node", "arduino-openaccess.mjs"]
