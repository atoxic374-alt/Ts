import { useGetActiveSession, useCreateSession, useStopSession, useListSessions, getGetActiveSessionQueryKey, getListSessionsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useQueryClient } from "@tanstack/react-query";
import { Play, Square, Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";

export default function Session() {
  const { data: activeSessionWrapper } = useGetActiveSession({ query: { queryKey: getGetActiveSessionQueryKey(), refetchInterval: 2000 } });
  const { data: history } = useListSessions({ query: { queryKey: getListSessionsQueryKey() } });
  
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createSession = useCreateSession();
  const stopSession = useStopSession();

  const session = activeSessionWrapper?.session;
  const isRunning = session?.status === 'running' || session?.status === 'waiting';

  const [countdown, setCountdown] = useState<number>(0);

  useEffect(() => {
    if (session?.status === 'waiting' && session.waitSeconds > 0) {
      setCountdown(session.waitSeconds);
      const interval = setInterval(() => {
        setCountdown((c) => Math.max(0, c - 1));
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setCountdown(0);
    }
  }, [session?.status, session?.waitSeconds]);

  const handleStart = () => {
    createSession.mutate({ data: { total: 10, waitSeconds: 5 } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
        toast({ title: "Session started" });
      }
    });
  };

  const handleStop = () => {
    if (session?.id) {
      stopSession.mutate({ id: session.id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
          toast({ title: "Session stopped" });
        }
      });
    }
  };

  const progressPercent = session?.total ? (session.progress / session.total) * 100 : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Live Session</h2>
        <p className="text-muted-foreground">Monitor and control automation execution.</p>
      </div>

      <Card className="border-2 border-primary/20 shadow-lg shadow-primary/5">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-lg uppercase tracking-widest text-primary">Execution Control</CardTitle>
          <div className="flex space-x-2">
            {!isRunning ? (
              <Button onClick={handleStart} disabled={createSession.isPending} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                <Play className="mr-2 h-4 w-4" fill="currentColor" /> START SESSION
              </Button>
            ) : (
              <Button variant="destructive" onClick={handleStop} disabled={stopSession.isPending} className="font-bold">
                <Square className="mr-2 h-4 w-4" fill="currentColor" /> STOP
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6 pt-4">
          <div className="flex justify-between items-end">
            <div>
              <p className="text-sm font-mono text-muted-foreground mb-1">STATUS</p>
              <div className="text-2xl font-bold uppercase tracking-wider">
                {session?.status || 'IDLE'}
              </div>
            </div>
            {session?.status === 'waiting' && (
              <div className="text-right">
                <p className="text-sm font-mono text-muted-foreground mb-1 flex items-center justify-end"><Clock className="h-3 w-3 mr-1"/> TIMEOUT</p>
                <div className="text-2xl font-bold font-mono text-accent">{countdown}s</div>
              </div>
            )}
            <div className="text-right">
              <p className="text-sm font-mono text-muted-foreground mb-1">PROGRESS</p>
              <div className="text-2xl font-bold font-mono">
                {session?.progress || 0} / {session?.total || 0}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Progress value={progressPercent} className="h-2" />
          </div>

          <div className="bg-muted/50 p-4 rounded-md font-mono text-xs text-muted-foreground overflow-y-auto h-32 whitespace-pre-wrap">
            {session?.logs || "No logs available. Start a session to see output."}
          </div>
        </CardContent>
      </Card>

      <div>
        <h3 className="text-lg font-medium mb-4">Session History</h3>
        <div className="grid gap-2">
          {history?.map((h) => (
            <div key={h.id} className="flex items-center justify-between p-3 border rounded-md bg-card">
              <div className="flex flex-col">
                <span className="font-medium text-sm">Session #{h.id}</span>
                <span className="text-xs text-muted-foreground">{new Date(h.createdAt).toLocaleString()}</span>
              </div>
              <div className="flex items-center space-x-4">
                <span className="font-mono text-sm">{h.progress}/{h.total}</span>
                <span className={`text-xs uppercase font-bold tracking-wider ${h.status === 'completed' ? 'text-primary' : h.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {h.status}
                </span>
              </div>
            </div>
          ))}
          {history?.length === 0 && (
            <div className="text-center p-4 text-muted-foreground border rounded-md">No past sessions.</div>
          )}
        </div>
      </div>
    </div>
  );
}
