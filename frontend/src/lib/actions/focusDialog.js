/** Keep keyboard focus inside the active dialog and restore it when dismissed. */
export function focusDialog(node) {
  const previous = document.activeElement;
  const selector =
    'button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]';
  const focus = () => node.querySelector(selector)?.focus();
  const timer = setTimeout(focus, 0);
  function key(event) {
    if (event.key !== "Tab") return;
    const nodes = [...node.querySelectorAll(selector)].filter(
      (el) => el.getClientRects().length,
    );
    if (!nodes.length) {
      event.preventDefault();
      node.focus();
      return;
    }
    const first = nodes[0],
      last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  node.addEventListener("keydown", key);
  return {
    update() {
      queueMicrotask(focus);
    },
    destroy() {
      clearTimeout(timer);
      node.removeEventListener("keydown", key);
      if (previous?.isConnected) previous.focus();
    },
  };
}
