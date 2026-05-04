import { useListBots, useCreateBot, useDeleteBot, getListBotsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Plus, Trash, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const botSchema = z.object({
  name: z.string().min(1, "Name is required"),
  token: z.string().min(1, "Token is required"),
  prefix: z.string().min(1, "Prefix is required"),
});

function MaskedToken({ text }: { text: string }) {
  const [visible, setVisible] = useState(false);
  const { toast } = useToast();

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  };

  return (
    <div className="flex items-center space-x-2 font-mono text-sm">
      <span>{visible ? text : "•".repeat(Math.min(text.length, 24))}</span>
      <button onClick={() => setVisible(!visible)} className="text-muted-foreground hover:text-foreground">
        {visible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
      </button>
      <button onClick={handleCopy} className="text-muted-foreground hover:text-foreground">
        <Copy className="h-3 w-3" />
      </button>
    </div>
  );
}

export default function Bots() {
  const { data: bots, isLoading } = useListBots({ query: { queryKey: getListBotsQueryKey() } });
  const [isAddOpen, setIsAddOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createBot = useCreateBot();
  const deleteBot = useDeleteBot();

  const form = useForm<z.infer<typeof botSchema>>({
    resolver: zodResolver(botSchema),
    defaultValues: { name: "", token: "", prefix: "!" },
  });

  const onSubmit = (data: z.infer<typeof botSchema>) => {
    createBot.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
        setIsAddOpen(false);
        form.reset();
        toast({ title: "Bot created" });
      },
      onError: () => toast({ title: "Failed to create bot", variant: "destructive" }),
    });
  };

  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to delete this bot?")) {
      deleteBot.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
          toast({ title: "Bot deleted" });
        }
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Bots</h2>
          <p className="text-muted-foreground">Manage your Discord bots.</p>
        </div>
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-2 h-4 w-4" /> Add Bot</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Discord Bot</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="token" render={({ field }) => (
                  <FormItem><FormLabel>Token</FormLabel><FormControl><Input type="password" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="prefix" render={({ field }) => (
                  <FormItem><FormLabel>Prefix</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <Button type="submit" className="w-full" disabled={createBot.isPending}>
                  {createBot.isPending ? "Adding..." : "Add Bot"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Prefix</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center">Loading...</TableCell></TableRow>
            ) : bots?.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No bots found</TableCell></TableRow>
            ) : (
              bots?.map((bot) => (
                <TableRow key={bot.id}>
                  <TableCell className="font-medium">{bot.name}</TableCell>
                  <TableCell><MaskedToken text={bot.token} /></TableCell>
                  <TableCell className="font-mono">{bot.prefix}</TableCell>
                  <TableCell>
                    <Badge variant={bot.status === 'active' ? 'default' : bot.status === 'error' ? 'destructive' : 'secondary'} className={bot.status === 'active' ? "bg-primary text-primary-foreground" : ""}>
                      {bot.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(bot.id)} disabled={deleteBot.isPending}>
                      <Trash className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
