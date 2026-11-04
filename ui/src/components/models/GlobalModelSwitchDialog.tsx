import { useEffect, useState } from "react";
import { ModelSwitchModal } from "./ModelSwitchModal";
import { modelsApi, type InstalledModel } from "../../lib/modelsApi";

/**
 * App-level model switch confirmation.
 *
 * The TopBar dropdown used to navigate to the Model Library merely to show a
 * modal. This dialog keeps the operator on their current view and performs the
 * restart-confirmed switch in place.
 */
export function GlobalModelSwitchDialog() {
  const [pending, setPending] = useState<InstalledModel | null>(null);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const model = (event as CustomEvent).detail as InstalledModel | undefined;
      if (model?.id) setPending(model);
    };
    window.addEventListener("swarm-open-model-switch-dialog", handleOpen);
    return () => window.removeEventListener("swarm-open-model-switch-dialog", handleOpen);
  }, []);

  const handleConfirm = async () => {
    if (!pending) return;
    const target = pending;
    try {
      await modelsApi.selectModel(target.id, true);
      localStorage.setItem("swarm_active_model_path", target.path);
      localStorage.setItem("swarm_active_model_name", target.name);
      if (target.gguf?.context_length) {
        localStorage.setItem("swarm_active_model_ctx", String(target.gguf.context_length));
      }
      window.dispatchEvent(new CustomEvent("swarm-model-changed", { detail: target }));
      window.dispatchEvent(new CustomEvent("swarm-model-library-refresh"));
    } finally {
      setPending(null);
    }
  };

  return (
    <ModelSwitchModal
      pendingSelect={pending ? { modelId: pending.id, modelName: pending.name } : null}
      onConfirm={handleConfirm}
      onDismiss={() => setPending(null)}
    />
  );
}
