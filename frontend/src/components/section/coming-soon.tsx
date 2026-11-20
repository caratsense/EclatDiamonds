import { Construction } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface ComingSoonProps {
  module: number;
  title: string;
}

/** Phase-1 empty state placeholder shown on every section page. */
export function ComingSoon({ module, title }: ComingSoonProps) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <Construction className="h-6 w-6" />
        </div>
        <div className="space-y-1">
          <p className="font-medium">Coming in Phase 2</p>
          <p className="max-w-md text-sm text-muted-foreground">
            The {title} workspace is scaffolded and navigable. Its
            store-scoped, role-aware screens will be built out next.
          </p>
        </div>
        <Badge variant="secondary">Module {module}</Badge>
      </CardContent>
    </Card>
  );
}
