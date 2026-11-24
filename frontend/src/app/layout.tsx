import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AtmaSutra — Self-Insight Thread",
  description: "Local-first personal health and habit intelligence vault",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
