- Container sessions, image builds, the Test shell, and cleanup now use whichever
  container engine is actually running: with both Docker and Podman installed, a
  stopped Docker no longer blocks a running Podman (and vice versa).
