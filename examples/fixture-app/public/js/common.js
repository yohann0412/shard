// Loaded on every page: marks the nav link for the current page.
for (const link of document.querySelectorAll('nav a')) {
  if (link.getAttribute('href') === window.location.pathname) {
    link.setAttribute('aria-current', 'page');
  }
}
