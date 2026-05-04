import { useGetRules, useUpdateRules, getGetRulesQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Save } from "lucide-react";

const rulesSchema = z.object({
  createTeams: z.boolean(),
  createBots: z.boolean(),
  linkBots: z.boolean(),
  quantity: z.coerce.number().min(1),
  botPrefix: z.string().min(1),
  waitMinutes: z.coerce.number().min(0),
});

export default function Rules() {
  const { data: rules, isLoading } = useGetRules({ query: { queryKey: getGetRulesQueryKey() } });
  const updateRules = useUpdateRules();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<z.infer<typeof rulesSchema>>({
    resolver: zodResolver(rulesSchema),
    defaultValues: {
      createTeams: false,
      createBots: false,
      linkBots: false,
      quantity: 1,
      botPrefix: "!",
      waitMinutes: 1,
    },
  });

  useEffect(() => {
    if (rules) {
      form.reset(rules);
    }
  }, [rules, form]);

  const onSubmit = (data: z.infer<typeof rulesSchema>) => {
    updateRules.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetRulesQueryKey() });
        toast({ title: "Rules updated successfully" });
      },
      onError: () => {
        toast({ title: "Failed to update rules", variant: "destructive" });
      }
    });
  };

  if (isLoading) return <div>Loading...</div>;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Automation Rules</h2>
        <p className="text-muted-foreground">Configure the execution parameters for sessions.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
              <CardDescription>Select what operations to perform.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField control={form.control} name="createTeams" render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base font-bold font-sans">إنشاء فرق جديده</FormLabel>
                    <p className="text-sm text-muted-foreground">Create new teams</p>
                  </div>
                  <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                </FormItem>
              )} />
              <FormField control={form.control} name="createBots" render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base font-bold font-sans">إنشاء بوكات جديده</FormLabel>
                    <p className="text-sm text-muted-foreground">Create new bots</p>
                  </div>
                  <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                </FormItem>
              )} />
              <FormField control={form.control} name="linkBots" render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base font-bold font-sans">ربط البوكات داخل كيم</FormLabel>
                    <p className="text-sm text-muted-foreground">Link bots to teams</p>
                  </div>
                  <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                </FormItem>
              )} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Parameters</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="quantity" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Quantity</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="waitMinutes" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Wait Time (Minutes)</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="botPrefix" render={({ field }) => (
                <FormItem>
                  <FormLabel>Bot Prefix</FormLabel>
                  <FormControl><Input {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </CardContent>
          </Card>

          <Button type="submit" disabled={updateRules.isPending} className="w-full font-bold tracking-widest uppercase">
            <Save className="mr-2 h-4 w-4" /> {updateRules.isPending ? "Saving..." : "Save Rules"}
          </Button>
        </form>
      </Form>
    </div>
  );
}
