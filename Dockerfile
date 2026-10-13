# GuessMe BD — ছোট, নন-রুট কনটেইনার (Fly.io, Railway, নিজস্ব সার্ভার ইত্যাদির জন্য)
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# SQLite ফাইল রাখার জন্য ডিরেক্টরি (ভলিউম মাউন্ট করুন: /app/data)
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
