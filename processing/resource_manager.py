"""
Drone3D Resource Manager.

Coordinates memory and disk resources between NodeODM and Ollama
within the Docker Desktop VM. Both services compete for the same
RAM pool (~20GB), so this module ensures clean handoffs:

  - After NodeODM processing completes → free NodeODM memory for Ollama
  - After Ollama analysis completes → free Ollama memory for next NodeODM job
  - Periodic sweeps catch orphaned resources from crashes/timeouts

The Docker Desktop VM allocates a fixed RAM pool. We can't resize it
dynamically, but we CAN ensure unused memory is released back to the
VM's free pool by cleaning up task data and unloading models.
"""

import logging
import time

import httpx
from django.conf import settings

logger = logging.getLogger("processing")


class ResourceManager:
    """Manages memory lifecycle between NodeODM and Ollama."""

    def __init__(self):
        self.nodeodm_url = (
            f"http://{settings.NODEODM_HOST}:{settings.NODEODM_PORT}"
        )
        self.ollama_url = getattr(
            settings, "OLLAMA_HOST", "http://localhost:11434"
        )

    # ─── NodeODM Cleanup ────────────────────────────────────

    def free_nodeodm_memory(self):
        """Remove all completed/failed/cancelled tasks from NodeODM.

        Each task retains uploaded images + intermediate files in memory
        and on disk. Removing them releases both.

        Safe to call at any time — running/queued tasks are preserved.

        Returns:
            Number of tasks removed.
        """
        RUNNING_STATUSES = {10, 20}  # queued, running

        try:
            resp = httpx.get(
                f"{self.nodeodm_url}/task/list", timeout=10
            )
            resp.raise_for_status()
            tasks = resp.json()
        except Exception as e:
            logger.warning(f"ResourceManager: cannot list NodeODM tasks: {e}")
            return 0

        if not tasks:
            return 0

        removed = 0
        for task_info in tasks:
            uuid = task_info.get("uuid")
            if not uuid:
                continue

            # Check if task is still active
            try:
                info_resp = httpx.get(
                    f"{self.nodeodm_url}/task/{uuid}/info", timeout=10
                )
                info_resp.raise_for_status()
                status_code = (
                    info_resp.json().get("status", {}).get("code", 0)
                )
            except Exception:
                # Can't get info → likely orphaned, safe to remove
                status_code = 40

            if status_code not in RUNNING_STATUSES:
                try:
                    del_resp = httpx.post(
                        f"{self.nodeodm_url}/task/remove",
                        data={"uuid": uuid},
                        timeout=30,
                    )
                    if del_resp.is_success:
                        removed += 1
                except Exception as e:
                    logger.warning(
                        f"ResourceManager: failed to remove NodeODM task "
                        f"{uuid}: {e}"
                    )

        if removed:
            logger.info(
                f"ResourceManager: freed NodeODM memory "
                f"({removed} task(s) removed)"
            )
        return removed

    # ─── Ollama Cleanup ─────────────────────────────────────

    def free_ollama_memory(self):
        """Unload all models from Ollama's RAM.

        Ollama keeps models resident in memory for fast inference.
        By sending keep_alive=0, we tell it to immediately evict
        the model. This is essential before NodeODM processing
        starts, since NodeODM needs as much RAM as possible for
        dense point cloud generation.

        Returns:
            Number of models unloaded.
        """
        try:
            resp = httpx.get(
                f"{self.ollama_url}/api/ps", timeout=10
            )
            resp.raise_for_status()
            loaded = resp.json().get("models", [])
        except Exception as e:
            logger.debug(f"ResourceManager: cannot check Ollama models: {e}")
            return 0

        if not loaded:
            return 0

        unloaded = 0
        for model_info in loaded:
            name = model_info.get("name") or model_info.get("model")
            if not name:
                continue
            try:
                httpx.post(
                    f"{self.ollama_url}/api/generate",
                    json={"model": name, "prompt": "", "keep_alive": 0},
                    timeout=30,
                )
                unloaded += 1
                logger.info(
                    f"ResourceManager: unloaded model '{name}' from memory"
                )
            except Exception as e:
                logger.warning(
                    f"ResourceManager: failed to unload '{name}': {e}"
                )

        if unloaded:
            logger.info(
                f"ResourceManager: freed Ollama memory "
                f"({unloaded} model(s) unloaded)"
            )
        return unloaded

    # ─── Pipeline Memory Transitions ─────────────────────────

    def prepare_for_processing(self):
        """Free all possible memory before NodeODM processing starts.

        Called at the beginning of the pipeline. Ensures Ollama isn't
        holding models in RAM that NodeODM will need for SfM/MVS.
        """
        logger.info("ResourceManager: preparing memory for NodeODM processing")
        models_freed = self.free_ollama_memory()
        tasks_freed = self.free_nodeodm_memory()

        if models_freed or tasks_freed:
            # Give the VM a moment to reclaim freed pages
            time.sleep(2)

        logger.info(
            f"ResourceManager: ready for processing "
            f"(freed {models_freed} model(s), {tasks_freed} task(s))"
        )

    def prepare_for_ai_analysis(self):
        """Free NodeODM memory before Ollama loads the vision model.

        Called between processing completion and AI analysis start.
        NodeODM's task data has already been downloaded, so all
        tasks can be safely removed to free RAM for the ~7GB
        vision model.
        """
        logger.info("ResourceManager: preparing memory for AI analysis")
        tasks_freed = self.free_nodeodm_memory()

        if tasks_freed:
            # NodeODM needs a moment to deallocate
            time.sleep(3)

        logger.info(
            f"ResourceManager: ready for AI analysis "
            f"({tasks_freed} task(s) freed)"
        )

    def cleanup_after_pipeline(self):
        """Full cleanup after the entire pipeline completes.

        Frees ALL resources — both NodeODM tasks and Ollama models.
        Ensures the VM is in a clean state for the next job.
        """
        logger.info("ResourceManager: post-pipeline cleanup")
        tasks_freed = self.free_nodeodm_memory()
        models_freed = self.free_ollama_memory()
        logger.info(
            f"ResourceManager: cleanup complete "
            f"({tasks_freed} task(s), {models_freed} model(s) freed)"
        )

    def get_memory_status(self) -> dict:
        """Return current memory usage summary for diagnostics."""
        status = {
            "nodeodm_tasks": 0,
            "nodeodm_running": 0,
            "ollama_models_loaded": 0,
            "ollama_available": False,
        }

        # NodeODM tasks
        try:
            resp = httpx.get(
                f"{self.nodeodm_url}/task/list", timeout=5
            )
            if resp.is_success:
                tasks = resp.json()
                status["nodeodm_tasks"] = len(tasks)
                # Count running tasks
                for t in tasks:
                    uuid = t.get("uuid")
                    if uuid:
                        try:
                            info = httpx.get(
                                f"{self.nodeodm_url}/task/{uuid}/info",
                                timeout=5,
                            )
                            code = info.json().get("status", {}).get("code", 0)
                            if code in (10, 20):
                                status["nodeodm_running"] += 1
                        except Exception:
                            pass
        except Exception:
            pass

        # Ollama models
        try:
            resp = httpx.get(f"{self.ollama_url}/api/ps", timeout=5)
            if resp.is_success:
                loaded = resp.json().get("models", [])
                status["ollama_models_loaded"] = len(loaded)
                status["ollama_available"] = True
        except Exception:
            pass

        return status
"""
Singleton accessor for use throughout the pipeline.
"""
_resource_manager = None


def get_resource_manager() -> ResourceManager:
    """Get the singleton ResourceManager instance."""
    global _resource_manager
    if _resource_manager is None:
        _resource_manager = ResourceManager()
    return _resource_manager
