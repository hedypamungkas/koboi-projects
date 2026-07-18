"""concierge_ext -- Northwind internal employee-services concierge extension for koboi-agent.

This use case is cross-instance agent-to-agent (A2A): three koboi containers run together
(see docker-compose.yml) --

  * ``concierge``      (front-door, port 8009) -- talks to the employee; uses the builtin
                        ``call_peer_agent`` tool to collaborate with the department peers.
  * ``peer-it``        (port 8011)             -- IT desk: asset lookup, password reset, access.
  * ``peer-facilities``(port 8012)             -- Facilities: desk moves, maintenance reports.

All three share this one installable package; each config wires only the tools it needs:
``concierge_ext.it_tools``, ``concierge_ext.facilities_tools``. The front-door's own logic is
the builtin ``call_peer_agent`` plus config-driven peers/policy/hooks/handover/memory -- so it
has no custom tool module. No koboi-core changes.
"""
