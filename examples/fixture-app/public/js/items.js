// Loaded on the items page: hides the items that do not contain the filter text.
const filter = document.querySelector('#item-filter');
const items = document.querySelectorAll('#items li');

filter.addEventListener('input', () => {
  const text = filter.value.trim().toLowerCase();
  for (const item of items) {
    item.hidden = !item.textContent.toLowerCase().includes(text);
  }
});
