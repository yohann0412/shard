// Loaded on the settings page: asks for confirmation before switching maintenance mode.
const form = document.querySelector('#maintenance-form');

form.addEventListener('submit', (event) => {
  const mode = form.elements.namedItem('mode').value;
  const question =
    mode === 'on'
      ? 'Turn maintenance mode on? Every user will see the banner and nobody can add items.'
      : 'Turn maintenance mode off?';
  if (!window.confirm(question)) {
    event.preventDefault();
  }
});
