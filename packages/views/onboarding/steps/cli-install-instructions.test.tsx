// Codeloom addition: cover the Codeloom install command and self-host setup.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { configStore } from "@multica/core/config";
import enCommon from "../../locales/en/common.json";
import enOnboarding from "../../locales/en/onboarding.json";
import { CliInstallInstructions } from "./cli-install-instructions";

const TEST_RESOURCES = { en: { common: enCommon, onboarding: enOnboarding } };

function renderInstructions(config?: {
  daemonServerUrl?: string;
  daemonAppUrl?: string;
}) {
  configStore.setState({
    cdnDomain: "",
    allowSignup: true,
    googleClientId: "",
    daemonServerUrl: "",
    daemonAppUrl: "",
    workspaceCreationDisabled: false,
  });
  if (config) {
    configStore.getState().setDaemonConfig(config);
  }
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <CliInstallInstructions />
    </I18nProvider>,
  );
}

describe("CliInstallInstructions", () => {
  it("installs the CLI from the Codeloom repository", () => {
    const { container } = renderInstructions();

    expect(container).toHaveTextContent(
      "curl -fsSL https://raw.githubusercontent.com/camelys624/codeloom/main/scripts/install.sh | bash",
    );
    expect(container).not.toHaveTextContent("multica-ai/multica");
  });

  it("falls back to cloud setup without daemon URLs", () => {
    const { container } = renderInstructions();

    expect(container).toHaveTextContent("multica setup");
    expect(container).not.toHaveTextContent("multica setup self-host");
  });

  it("uses self-host daemon URLs from runtime config", () => {
    const { container } = renderInstructions({
      daemonServerUrl: "https://api.example.com/",
      daemonAppUrl: "https://app.example.com/",
    });

    expect(container).toHaveTextContent(
      "multica setup self-host --server-url https://api.example.com --app-url https://app.example.com",
    );
    expect(container).toHaveTextContent(
      "multica daemon restart --no-auto-update",
    );
  });
});
