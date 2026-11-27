import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AtmaSutra — Self-Insight Thread",
  description: "A private journal for sleep, recovery, habits, and personal experiments.",
  applicationName: "AtmaSutra",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "AtmaSutra" },
};

export const viewport: Viewport = {
  themeColor: "#111412",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
