"use client";

import { useState } from "react";
import { BookOpen, FileText, Loader2, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDeleteKnowledge,
  useKnowledgeDocuments,
  useKnowledgeSearch,
  useUploadKnowledge,
} from "@/lib/queries/knowledge";

export function KnowledgePanel() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [search, setSearch] = useState("");
  const documents = useKnowledgeDocuments();
  const upload = useUploadKnowledge();
  const remove = useDeleteKnowledge();
  const results = useKnowledgeSearch(search);

  function submit() {
    if (!file) return toast.error("Choose a PDF, DOCX, DOC or TXT file.");
    upload.mutate(
      { file, title: title || undefined },
      {
        onSuccess: ({ deduplicated }) => {
          toast.success(deduplicated ? "This file is already in the library." : "Document stored; extraction queued.");
          setFile(null);
          setTitle("");
        },
        onError: () => toast.error("The document could not be uploaded."),
      },
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4" /> AI CRM knowledge library
          </CardTitle>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Files are kept in private storage. Text PDFs, DOCX and TXT are extracted in the background.
            Scanned PDFs are flagged for OCR; legacy DOC files are retained but need conversion.
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <Input
            type="file"
            accept=".pdf,.docx,.doc,.txt"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Optional display title" />
          <Button onClick={submit} disabled={!file || upload.isPending}>
            {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Upload
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Search extracted knowledge</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search policy, product, process…" />
          </div>
          {search.trim().length >= 2 && results.isLoading ? <Skeleton className="h-20 w-full" /> : null}
          {results.data?.map((result) => (
            <div key={`${result.document.id}:${result.chunkIndex}`} className="rounded-lg border p-3">
              <p className="text-xs font-medium">{result.document.title}</p>
              <p className="mt-1 line-clamp-4 whitespace-pre-line text-xs text-muted-foreground">{result.content}</p>
            </div>
          ))}
          {search.trim().length >= 2 && results.data?.length === 0 ? (
            <p className="text-xs text-muted-foreground">No extracted passage matched.</p>
          ) : null}
        </CardContent>
      </Card>

      {documents.isLoading ? <Skeleton className="h-40 w-full" /> : null}
      {documents.data?.length === 0 ? (
        <EmptyState icon={FileText} title="No knowledge documents yet" description="Upload approved business information for the AI CRM." />
      ) : null}
      {documents.data?.map((document) => (
        <Card key={document.id}>
          <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{document.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {document.originalFileName} · {(document.sizeBytes / 1024).toFixed(1)} KB · {document._count?.chunks ?? 0} chunks
              </p>
              {document.error ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{document.error}</p> : null}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={document.status === "ready" ? "secondary" : document.status === "failed" ? "destructive" : "outline"}>
                {document.status.replaceAll("_", " ")}
              </Badge>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Delete ${document.title}`}
                disabled={remove.isPending}
                onClick={() => {
                  if (!window.confirm(`Delete "${document.title}" and its extracted knowledge?`)) return;
                  remove.mutate(document.id, { onError: () => toast.error("Could not delete document.") });
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
