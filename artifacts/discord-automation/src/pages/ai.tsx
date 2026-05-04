import { useAiChat } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useState, useRef, useEffect } from "react";
import { Bot, Send, User } from "lucide-react";

interface Message {
  role: "user" | "ai";
  content: string;
}

export default function Ai() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "ai", content: "System online. How can I assist with your Discord automation setup?" }
  ]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const aiChat = useAiChat();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMsg = input.trim();
    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setInput("");

    aiChat.mutate({ data: { message: userMsg } }, {
      onSuccess: (response) => {
        setMessages(prev => [...prev, { role: "ai", content: response.reply }]);
      },
      onError: () => {
        setMessages(prev => [...prev, { role: "ai", content: "[ERROR] Failed to connect to AI core." }]);
      }
    });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)]">
      <div className="mb-4">
        <h2 className="text-2xl font-bold tracking-tight">AI Assistant</h2>
        <p className="text-muted-foreground">Expert guidance for automation workflows.</p>
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden border-border bg-card/50">
        <ScrollArea className="flex-1 p-4" ref={scrollRef}>
          <div className="space-y-4">
            {messages.map((msg, i) => (
              <div key={i} className={`flex items-start gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`p-2 rounded-md ${msg.role === 'user' ? 'bg-primary/20 text-primary-foreground' : 'bg-secondary text-secondary-foreground'}`}>
                  {msg.role === 'user' ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4 text-primary" />}
                </div>
                <div className={`rounded-lg p-3 max-w-[80%] text-sm ${msg.role === 'user' ? 'bg-primary/10 border border-primary/20' : 'bg-muted/50 border border-border'}`}>
                  {msg.content}
                </div>
              </div>
            ))}
            {aiChat.isPending && (
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-md bg-secondary"><Bot className="h-4 w-4 text-primary animate-pulse" /></div>
                <div className="rounded-lg p-3 bg-muted/50 border border-border text-sm flex items-center space-x-1">
                  <div className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce" style={{animationDelay: "0ms"}} />
                  <div className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce" style={{animationDelay: "150ms"}} />
                  <div className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce" style={{animationDelay: "300ms"}} />
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
        
        <div className="p-4 border-t border-border bg-card">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <Input 
              value={input} 
              onChange={e => setInput(e.target.value)} 
              placeholder="Ask about Discord limits, token management, or rules..." 
              className="flex-1 font-mono text-sm bg-input border-border focus-visible:ring-primary"
              disabled={aiChat.isPending}
            />
            <Button type="submit" disabled={aiChat.isPending || !input.trim()} size="icon" className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
