const byId = (id) => document.getElementById(id);
const form = byId('record-form');
const status = byId('status');
const save = byId('save');
let spec;

async function request(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function fieldControl(field) {
  const row = element('label');
  row.append(element('span', field.label));
  const kind = ['textarea', 'select'].includes(field.type) ? field.type : 'input';
  const input = element(kind);
  if (kind === 'input') {
    input.type = field.type;
    if (field.type === 'number') input.step = 'any';
  }
  if (kind === 'select') {
    const placeholder = element('option', '请选择');
    placeholder.value = '';
    placeholder.disabled = field.required;
    input.append(placeholder, ...field.options.map((value) => element('option', value)));
  }
  input.name = field.id;
  input.dataset.testid = field.id;
  input.required = field.required;
  if (['textarea', 'text'].includes(field.type)) input.maxLength = 500;
  row.append(input);
  return row;
}

async function refreshList() {
  const records = await request('/api/records');
  const list = byId('records');
  if (!records.length) {
    const empty = element('p', spec.emptyLabel);
    empty.className = 'empty';
    empty.dataset.testid = 'records-empty';
    list.replaceChildren(empty);
    return;
  }
  const table = element('table');
  const heading = table.createTHead().insertRow();
  heading.append(...spec.fields.map((field) => element('th', field.label)));
  const tbody = table.createTBody();
  for (const record of records) {
    const row = tbody.insertRow();
    row.dataset.testid = 'record-row';
    for (const field of spec.fields) row.append(element('td', record.values[field.id]));
  }
  list.replaceChildren(table);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  save.disabled = true;
  status.textContent = '';
  try {
    await request('/api/records', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    form.reset();
    try {
      await refreshList();
      status.textContent = spec.successMessage;
    } catch {
      status.textContent = '记录已保存，请刷新页面查看。';
    }
  } catch (error) {
    status.textContent = error.message || '保存失败，请重试。';
  } finally {
    save.disabled = false;
  }
});

try {
  spec = await request('/api/spec');
  document.title = spec.title;
  byId('title').textContent = spec.title;
  byId('description').textContent = spec.description;
  save.textContent = spec.submitLabel;
  byId('list-title').textContent = spec.listLabel;
  byId('fields').replaceChildren(...spec.fields.map(fieldControl));
  await refreshList();
  save.disabled = false;
} catch {
  status.textContent = '演示系统加载失败，请刷新。';
}
