import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'IntentChain — Intent Integrity Firewall for Multi-Agent Commerce',
  description:
    'When agents delegate to agents, IntentChain verifies the whole chain still serves what the human asked for — before a payment reaches PayPal.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
