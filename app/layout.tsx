import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dead Person Vault",
  description: "On-chain Bitcoin inheritance system on OP_NET",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
