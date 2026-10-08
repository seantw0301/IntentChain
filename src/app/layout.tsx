import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'IntentChain — Verifiable Human Intent for Agentic Commerce',
  description:
    'A trust layer between AI agents and PayPal. Every AI payment must prove why it was allowed.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
