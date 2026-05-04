import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Users,
  Bot,
  Activity,
  Settings,
  MessageSquare,
  Cpu,
} from "lucide-react";
import React from "react";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Accounts", href: "/accounts", icon: Users },
  { name: "Bots", href: "/bots", icon: Bot },
  { name: "Session", href: "/session", icon: Activity },
  { name: "Rules", href: "/rules", icon: Settings },
  { name: "AI Assistant", href: "/ai", icon: MessageSquare },
  { name: "AI Agent", href: "/agent", icon: Cpu },
];

export function MainLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground dark selection:bg-primary/30">
      {/* Sidebar */}
      <div className="hidden md:flex md:w-64 md:flex-col">
        <div className="flex flex-col flex-grow border-r border-border bg-card">
          <div className="flex h-16 shrink-0 items-center px-6">
            <h1 className="text-xl font-bold text-primary tracking-tight">TRUE<span className="text-foreground">-STUDIO</span></h1>
          </div>
          <div className="flex flex-1 flex-col overflow-y-auto">
            <nav className="flex-1 space-y-1 px-4 py-4">
              {navigation.map((item) => {
                const isActive = location === item.href;
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    className={cn(
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                      "group flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors"
                    )}
                  >
                    <item.icon
                      className={cn(
                        isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                        "mr-3 h-5 w-5 shrink-0 transition-colors"
                      )}
                      aria-hidden="true"
                    />
                    {item.name}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-y-auto bg-background p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
