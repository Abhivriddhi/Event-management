import { Geist, Geist_Mono } from "next/font/google";
import PageAccessGuard from "@/components/PageAccessGuard";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "Abhivruddhi Admin Panel",
  description: "Attendance system",
  icons: {
    icon: "/icon.png",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <PageAccessGuard>{children}</PageAccessGuard>
      </body>
    </html>
  );
}
