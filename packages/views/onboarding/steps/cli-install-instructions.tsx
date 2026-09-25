"use client";

// Modified for Codeloom: install the pinned CLI from the Codeloom repository
// and point `multica setup` at this server instead of Multica Cloud.

import { useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import { useConfigStore } from "@multica/core/config";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import { CODE_LIGATURE_CLASS } from "@multica/ui/lib/code-style";
import { cn } from "@multica/ui/lib/utils";
import { copyText } from "@multica/ui/lib/clipboard";
import { useT } from "../../i18n";

const INSTALL_CMD =
  "curl -fsSL https://raw.githubusercontent.com/camelys624/codeloom/main/scripts/install.sh | bash";
const CLOUD_SETUP_CMD = "multica setup";

function normalizeCommandURL(url: string | undefined) {
  return url?.trim().replace(/\/+$/, "") ?? "";
}

// Mirrors the self-host commands in runtimes/ConnectRemoteDialog.
function setupCommand(serverUrl: string | undefined, appUrl: string | undefined) {
  const normalizedServerUrl = normalizeCommandURL(serverUrl);
  const normalizedAppUrl = normalizeCommandURL(appUrl);
  if (!normalizedServerUrl || !normalizedAppUrl) return CLOUD_SETUP_CMD;
  return `multica setup self-host --server-url ${normalizedServerUrl} --app-url ${normalizedAppUrl}
multica daemon restart --no-auto-update`;
}

function CopyButton({ text }: { text: string }) {
  const { t } = useT("onboarding");
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="shrink-0 rounded-xs p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label={t(($) => $.cli_install.copy_aria)}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function Step({ n, label, cmd }: { n: number; label: string; cmd: string }) {
  return (
    <div>
      <p className="mb-1.5 text-caption font-medium text-foreground">
        {n}. {label}
      </p>
      <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 font-mono text-body">
        <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <code
          className={cn(
            "min-w-0 flex-1 whitespace-pre-wrap break-all",
            CODE_LIGATURE_CLASS,
          )}
        >
          {cmd}
        </code>
        <CopyButton text={cmd} />
      </div>
    </div>
  );
}

/**
 * CLI install instructions — two copy-and-run commands. Step 1 is the
 * Codeloom install script. Step 2 connects to the daemon URLs this server
 * publishes in its runtime config, falling back to the cloud `multica setup`
 * when none are configured.
 */
export function CliInstallInstructions() {
  const { t } = useT("onboarding");
  const daemonServerUrl = useConfigStore((s) => s.daemonServerUrl);
  const daemonAppUrl = useConfigStore((s) => s.daemonAppUrl);
  return (
    <Card className="w-full">
      <CardContent className="space-y-4 pt-4">
        <p className="text-caption leading-[1.55] text-muted-foreground">
          {t(($) => $.cli_install.intro)}
        </p>
        <Step n={1} label={t(($) => $.cli_install.step1_label)} cmd={INSTALL_CMD} />
        <Step
          n={2}
          label={t(($) => $.cli_install.step2_label)}
          cmd={setupCommand(daemonServerUrl, daemonAppUrl)}
        />
      </CardContent>
    </Card>
  );
}
