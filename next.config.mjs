/** @type {import('next').NextConfig} */
const nextConfig = {
  // Local embeddings (server/semantic.ts) load native onnxruntime binaries at runtime.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
};

export default nextConfig;
