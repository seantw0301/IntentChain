import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'IntentChain Business Agent — Trusted Autonomous Travel & Procurement for Small Businesses',
  description:
    'AI agents that book travel and buy supplies for small businesses through PayPal — inside limits the owner sets, verified at every hand-off between agents.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
