#!/usr/bin/env python3
"""Example: Hermes orchestrator monitor on Windows, roadctl in WSL.

Copy this and monitor_common.py to Hermes's scripts directory. Adapt AGENT.
The last work prompt is retained during idle/blocked ticks to avoid a model wakeup.
"""
from monitor_common import sticky, tick

AGENT = "hermes@home-host"

if __name__ == "__main__":
    sticky("road-orchestrator", tick(AGENT, "take,accept,start,stale"))
