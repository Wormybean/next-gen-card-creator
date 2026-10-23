import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Next-gen Card Creator",
  description: "Turn lecture slides and question sets into Anki cloze cards",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-AU">
      <head>
        {/* Google AdSense, website only (never the desktop app): its site check looks for this tag in the page's own <head>. */}
        {process.env.VERCEL && (
          <script
            async
            src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2424745066068900"
            crossOrigin="anonymous"
          />
        )}
      </head>
      <body>{children}</body>
    </html>
  );
}
