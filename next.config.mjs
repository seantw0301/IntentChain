/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/intentchain',
  serverExternalPackages: ['@paypal/agent-toolkit'],
  poweredByHeader: false,
};

export default nextConfig;
