"use client";

// Modified for Codeloom: initialize the workspace without collecting a profile.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { completeOnboarding } from "@multica/core/onboarding";
import { paths, resolvePostAuthDestination } from "@multica/core/paths";
import { workspaceKeys } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { MulticaIcon } from "@multica/ui/components/common/multica-icon";
import { useT } from "@multica/views/i18n";

export default function OnboardingPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);
  const isLoading = useAuthStore((s) => s.isLoading);
  const { t } = useT("ui");
  const [error, setError] = useState<unknown>(null);
  const initialization = useRef<{ userId: string; promise: Promise<string> } | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!userId) {
      router.replace(paths.login());
      return;
    }

    // Reuse the in-flight operation across StrictMode effect replays.
    if (initialization.current?.userId !== userId) {
      initialization.current = {
        userId,
        promise: (async () => {
          let workspaces = await api.listWorkspaces();
          if (workspaces.length === 0) {
            // Stable per-user slug makes refreshes and concurrent tabs converge.
            // A conflicting workspace is reusable only if membership is verified.
            const slug = `codeloom-${userId}`;
            try {
              workspaces = [await api.createWorkspace({ name: "Codeloom", slug })];
            } catch (err) {
              if (!(err instanceof ApiError) || err.status !== 409) throw err;
              workspaces = await api.listWorkspaces();
              if (!workspaces.some((ws) => ws.slug === slug)) throw err;
            }
          }
          qc.setQueryData(workspaceKeys.list(), workspaces);
          await completeOnboarding(undefined, workspaces[0]?.id);
          return resolvePostAuthDestination(workspaces, true);
        })(),
      };
    }

    let active = true;
    initialization.current.promise.then(
      (destination) => {
        if (active) router.replace(destination);
      },
      (err: unknown) => {
        if (active) setError(err);
      },
    );
    return () => { active = false; };
  }, [isLoading, userId, qc, router]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      {error ? (
        <>
          <p role="alert" className="text-sm text-destructive">
            {error instanceof Error ? error.message : t(($) => $.error_boundary.description)}
          </p>
          <Button onClick={() => window.location.reload()}>
            {t(($) => $.error_boundary.try_again)}
          </Button>
        </>
      ) : (
        <MulticaIcon className="size-6 animate-pulse" />
      )}
    </div>
  );
}
