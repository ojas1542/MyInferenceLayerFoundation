import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Nunito } from "next/font/google";
import { APP_NAME } from "@/lib/brand";
import "./globals.css";

const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Chat with your local llama.cpp models",
};

export const viewport: Viewport = {
  themeColor: "#4e6045",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${nunito.variable} ${jetbrainsMono.variable} antialiased`}
    >
      <body className="font-sans">{children}</body>
    </html>
  );
}
