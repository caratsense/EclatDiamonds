"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export interface KnowledgeDocument {
  id: string;
  title: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  status: "uploaded" | "extracting" | "ready" | "needs_ocr" | "needs_conversion" | "failed";
  extractionMethod: string | null;
  extractedChars: number;
  error: string | null;
  createdAt: string;
  _count?: { chunks: number };
}

export interface KnowledgeSearchResult {
  document: { id: string; title: string; originalFileName: string };
  chunkIndex: number;
  content: string;
}

export function useKnowledgeDocuments() {
  return useQuery({
    queryKey: ["knowledge", "documents"],
    queryFn: async () => (await api.get<KnowledgeDocument[]>("/knowledge")).data,
    refetchInterval: (query) =>
      query.state.data?.some((document) => document.status === "extracting") ? 3000 : false,
  });
}

export function useUploadKnowledge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, title }: { file: File; title?: string }) => {
      const form = new FormData();
      form.append("file", file);
      if (title?.trim()) form.append("title", title.trim());
      return (
        await api.post<{ document: KnowledgeDocument; deduplicated: boolean }>(
          "/knowledge",
          form,
          { headers: { "Content-Type": undefined }, transformRequest: [(value) => value] },
        )
      ).data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["knowledge"] }),
  });
}

export function useDeleteKnowledge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/knowledge/${id}`)).data,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["knowledge"] }),
  });
}

export function useKnowledgeSearch(query: string) {
  const term = query.trim();
  return useQuery({
    queryKey: ["knowledge", "search", term],
    enabled: term.length >= 2,
    queryFn: async () =>
      (await api.get<KnowledgeSearchResult[]>("/knowledge/search", { params: { q: term } })).data,
  });
}
