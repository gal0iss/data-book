const state = {
  books: [],
  booksById: new Map(),
  analyses: new Map(),
  loadingIds: new Set(),
  selectedBookId: null,
  selectedRelationship: null,
  view: "conexiones",
  zoom: 1,
  panX: 0,
  panY: 0,
};

const svgNS = "http://www.w3.org/2000/svg";
const graph = document.querySelector("#graph");
const graphWorld = document.querySelector("#graph-world");
const edgesElement = document.querySelector("#edges");
const nodesElement = document.querySelector("#nodes");
const details = document.querySelector("#details");
const toast = document.querySelector("#toast");
let toastTimer;
let dragStart = null;

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgElement(name, attributes = {}) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}

function showView(viewName) {
  state.view = viewName;
  document.querySelectorAll(".view").forEach((view) => {
    view.hidden = view.id !== `view-${viewName}`;
  });
  document.querySelectorAll(".nav-button").forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelector("#crumb").textContent = viewName.toLocaleUpperCase("es");
}

function renderCatalog() {
  const catalog = document.querySelector("#catalog");
  const status = document.querySelector("#catalog-status");
  const query = document.querySelector("#search").value.trim().toLocaleLowerCase("es");
  const owner = document.querySelector("#owner-filter").value;
  const visibleBooks = state.books.filter((book) => {
    const matchesText = `${book.title} ${book.author}`.toLocaleLowerCase("es").includes(query);
    return matchesText && (owner === "all" || book.owner === owner);
  });
  catalog.replaceChildren();
  status.textContent = `${visibleBooks.length} ${visibleBooks.length === 1 ? "libro" : "libros"}`;

  for (const book of visibleBooks) {
    const card = element("button", "book");
    card.type = "button";
    card.setAttribute("aria-label", `Analizar ${book.title}, de ${book.author}`);
    card.addEventListener("click", () => requestAnalysis(book.id));
    card.append(element("span", "cover", book.title));
    card.append(element("span", "book-title", book.title));
    card.append(element("span", "book-author", book.author));
    card.append(element("span", `owner-tag ${book.owner.toLowerCase()}`, `Biblioteca ${book.owner}`));
    catalog.append(card);
  }
  if (!visibleBooks.length) status.textContent = "No hay libros que coincidan con la búsqueda.";
}

function renderRecommendations(analysis) {
  const container = document.querySelector("#recommendations");
  const selected = state.booksById.get(state.selectedBookId);
  container.replaceChildren();
  if (!analysis || !selected) {
    const empty = element("article", "empty-state");
    empty.append(element("span", "empty-mark", "✧"));
    empty.append(element("h2", "", "Aún no hay recomendaciones"));
    empty.append(element("p", "", "Ve a Libros y elige una obra para pedir un análisis."));
    const button = element("button", "primary", "Explorar libros");
    button.type = "button";
    button.dataset.go = "libros";
    empty.append(button);
    container.append(empty);
    return;
  }

  const heading = element("p", "rec-context", `Basadas en ${selected.title} · ${selected.author}`);
  container.append(heading);
  if (!analysis.recommendations.length) {
    container.append(element("article", "empty-state", "Gemini no encontró recomendaciones que pudiera justificar para esta obra."));
    return;
  }
  for (const suggestion of analysis.recommendations) {
    const book = state.booksById.get(suggestion.recommended_book_id);
    if (!book) continue;
    const card = element("article", "rec");
    card.append(element("div", "cover", book.title));
    const content = element("div", "");
    content.append(element("p", "eyebrow", `BIBLIOTECA ${book.owner}`));
    content.append(element("h2", "", book.title));
    content.append(element("p", "rec-context", book.author));
    content.append(element("p", "", suggestion.reason));
    const actions = element("div", "rec-actions");
    const connectionButton = element("button", "text-button", "Ver conexión");
    connectionButton.type = "button";
    connectionButton.addEventListener("click", () => {
      const relationship = analysis.relationships.find((link) =>
        (link.source_book_id === state.selectedBookId && link.target_book_id === book.id)
        || (link.target_book_id === state.selectedBookId && link.source_book_id === book.id));
      if (relationship) selectRelationship(relationship);
      showView("conexiones");
    });
    actions.append(connectionButton);
    content.append(actions);
    card.append(content);
    container.append(card);
  }
}

function positionsForBooks(analysis) {
  const positions = new Map();
  const center = { x: 480, y: 360 };
  if (state.selectedBookId === null) return positions;
  positions.set(state.selectedBookId, center);
  const recommendationIds = (analysis?.recommendations ?? [])
    .map((item) => item.recommended_book_id)
    .filter((id) => id !== state.selectedBookId);
  recommendationIds.forEach((id, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / recommendationIds.length;
    positions.set(id, {
      x: center.x + Math.cos(angle) * 230,
      y: center.y + Math.sin(angle) * 230,
    });
  });
  return positions;
}

function wrapLabel(text, maxLength) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > maxLength) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function relationshipKey(link) {
  return [link.source_book_id, link.target_book_id].sort((a, b) => a - b).join(":");
}

function updateGraphTransform() {
  graphWorld.setAttribute("transform", `translate(${state.panX} ${state.panY}) scale(${state.zoom})`);
}

function renderGraph() {
  edgesElement.replaceChildren();
  nodesElement.replaceChildren();
  const analysis = state.analyses.get(state.selectedBookId);
  const relationships = analysis?.relationships ?? [];
  const graphBookIds = new Set(state.selectedBookId === null ? [] : [state.selectedBookId]);
  for (const link of relationships) {
    graphBookIds.add(link.source_book_id);
    graphBookIds.add(link.target_book_id);
  }
  const positions = positionsForBooks(analysis);
  const activeKey = state.selectedRelationship ? relationshipKey(state.selectedRelationship) : null;
  for (const link of relationships) {
    const source = positions.get(link.source_book_id);
    const target = positions.get(link.target_book_id);
    const sourceBook = state.booksById.get(link.source_book_id);
    const targetBook = state.booksById.get(link.target_book_id);
    if (!source || !target || !sourceBook || !targetBook) continue;

    const group = svgElement("g", { class: "edge-group", tabindex: "0", role: "button" });
    const title = `${sourceBook.title} — ${targetBook.title}: ${link.reason}`;
    group.setAttribute("aria-label", title);
    group.dataset.key = relationshipKey(link);
    const lineAttrs = { x1: source.x, y1: source.y, x2: target.x, y2: target.y };
    group.append(svgElement("line", { ...lineAttrs, class: "edge-hit" }));
    group.append(svgElement("line", { ...lineAttrs, class: "edge" }));
    const svgTitle = svgElement("title");
    svgTitle.textContent = title;
    group.append(svgTitle);
    const choose = () => selectRelationship(link);
    group.addEventListener("click", choose);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); }
    });
    if (activeKey === group.dataset.key) group.classList.add("selected");
    edgesElement.append(group);
  }

  for (const bookId of graphBookIds) {
    const book = state.booksById.get(bookId);
    if (!book) continue;
    const point = positions.get(book.id);
    const isSelected = book.id === state.selectedBookId;
    const node = svgElement("g", { class: `node${isSelected ? " central" : " satellite"}`, tabindex: "0", role: "button" });
    node.dataset.id = String(book.id);
    const label = `${book.title}, ${book.author}, Biblioteca ${book.owner}`;
    node.setAttribute("aria-label", label);
    if (isSelected) node.classList.add("selected");
    const circle = svgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: isSelected ? 94 : 78,
      fill: isSelected ? "#ad6348" : (book.owner === "A" ? "#f0dacb" : "#e3e7dc"),
    });
    node.append(circle);
    const titleLines = wrapLabel(book.title, isSelected ? 21 : 17).slice(0, 4);
    const titleText = svgElement("text", { x: point.x, y: point.y - (titleLines.length - 1) * 7, class: "book-title" });
    for (const [index, line] of titleLines.entries()) {
      const span = svgElement("tspan", { x: point.x, dy: index === 0 ? 0 : 14 });
      span.textContent = line;
      titleText.append(span);
    }
    node.append(titleText);
    const authorText = svgElement("text", { x: point.x, y: point.y + titleLines.length * 7 + 12, class: "book-author" });
    authorText.textContent = book.author;
    node.append(authorText);
    const ownerText = svgElement("text", { x: point.x, y: point.y + titleLines.length * 7 + 27, class: "book-owner" });
    ownerText.textContent = `Biblioteca ${book.owner}`;
    node.append(ownerText);
    const title = svgElement("title");
    title.textContent = label;
    node.append(title);
    const focusNode = () => {
      const relationship = relationships.find((link) =>
        link.source_book_id === book.id || link.target_book_id === book.id);
      if (relationship) selectRelationship(relationship);
    };
    node.addEventListener("click", focusNode);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); focusNode(); }
    });
    nodesElement.append(node);
  }
  const emptyMessage = document.querySelector("#graph-empty");
  emptyMessage.classList.toggle("has-links", relationships.length > 0);
  if (analysis && relationships.length === 0) {
    const selected = state.booksById.get(state.selectedBookId);
    emptyMessage.textContent = `Gemini no encontró conexiones defendibles para “${selected.title}”.`;
  } else if (!analysis) {
    emptyMessage.textContent = "Elige un libro para descubrir sus conexiones con la otra biblioteca.";
  }
  const caption = document.querySelector("#graph-caption");
  const selectedBook = state.booksById.get(state.selectedBookId);
  caption.textContent = analysis && selectedBook
    ? `${relationships.length} ${relationships.length === 1 ? "conexión" : "conexiones"} alrededor de ${selectedBook.title} · Selecciona una línea para leer su explicación.`
    : "Elige un libro para generar relaciones entre bibliotecas.";
  updateGraphTransform();
}

function selectRelationship(link) {
  state.selectedRelationship = link;
  renderGraph();
  const source = state.booksById.get(link.source_book_id);
  const target = state.booksById.get(link.target_book_id);
  details.replaceChildren();
  details.append(element("p", "eyebrow", "DETALLE DE CONEXIÓN"));
  details.append(element("h2", "", "Una relación entre obras"));
  const books = element("div", "detail-books");
  for (const [label, book] of [["OBRA DE LA BIBLIOTECA " + source.owner, source], ["OBRA DE LA BIBLIOTECA " + target.owner, target]]) {
    const item = element("div", "detail-book");
    item.append(element("small", "", label));
    item.append(element("strong", "", book.title));
    item.append(element("div", "muted", book.author));
    books.append(item);
  }
  details.append(books);
  details.append(element("hr"));
  details.append(element("p", "eyebrow", "EXPLICACIÓN DE GEMINI"));
  details.append(element("p", "detail-reason", link.reason));
}

async function requestAnalysis(bookId) {
  if (state.analyses.has(bookId)) {
    state.selectedBookId = bookId;
    state.selectedRelationship = null;
    renderGraph();
    renderRecommendations(state.analyses.get(bookId));
    showView("recomendaciones");
    return;
  }
  if (state.loadingIds.has(bookId)) return;
  const book = state.booksById.get(bookId);
  state.loadingIds.add(bookId);
  state.selectedBookId = bookId;
  state.selectedRelationship = null;
  renderGraph();
  showView("recomendaciones");
  const container = document.querySelector("#recommendations");
  container.replaceChildren(element("article", "empty-state", `Analizando “${book.title}” con Gemini…`));
  try {
    const response = await fetch("/api/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ book_id: bookId }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "No se pudo completar el análisis.");
    state.analyses.set(bookId, result);
    renderRecommendations(result);
    renderGraph();
  } catch (error) {
    container.replaceChildren();
    const failure = element("article", "empty-state");
    failure.append(element("h2", "", "No pudimos obtener las recomendaciones"));
    failure.append(element("p", "", error.message || "Revisa la conexión con el servidor y vuelve a intentarlo."));
    const retry = element("button", "primary", "Intentar de nuevo");
    retry.type = "button";
    retry.addEventListener("click", () => requestAnalysis(bookId));
    failure.append(retry);
    container.append(failure);
    showToast(error.message || "Error al consultar Gemini.");
  } finally {
    state.loadingIds.delete(bookId);
  }
}

async function loadBooks() {
  const status = document.querySelector("#catalog-status");
  try {
    const response = await fetch("/api/books");
    const books = await response.json();
    if (!response.ok) throw new Error(books.error || "No se pudo cargar el catálogo.");
    state.books = books;
    state.booksById = new Map(books.map((book) => [book.id, book]));
    renderCatalog();
    renderGraph();
  } catch (error) {
    status.textContent = error.message || "No se pudo cargar el catálogo.";
    showToast(status.textContent);
  }
}

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});
document.querySelector(".brand").addEventListener("click", () => showView("libros"));
document.querySelector("main").addEventListener("click", (event) => {
  const target = event.target.closest("[data-go]");
  if (target) showView(target.dataset.go);
});
document.querySelector("#search").addEventListener("input", renderCatalog);
document.querySelector("#owner-filter").addEventListener("change", renderCatalog);
document.querySelector("#zoom-in").addEventListener("click", () => { state.zoom = Math.min(2.7, state.zoom * 1.2); updateGraphTransform(); });
document.querySelector("#zoom-out").addEventListener("click", () => { state.zoom = Math.max(.55, state.zoom / 1.2); updateGraphTransform(); });
document.querySelector("#reset").addEventListener("click", () => {
  state.zoom = 1; state.panX = 0; state.panY = 0; state.selectedRelationship = null;
  renderGraph();
  details.innerHTML = "<p class=\"eyebrow\">DETALLE DE CONEXIÓN</p><h2>Explora el mapa</h2><p class=\"muted\">Selecciona una línea para leer la explicación que generó Gemini.</p><hr><p class=\"detail-hint\">Las obras de la biblioteca A aparecen en terracota y las de la B en verde oliva.</p>";
});

graph.addEventListener("wheel", (event) => {
  event.preventDefault();
  state.zoom = Math.max(.55, Math.min(2.7, state.zoom * (event.deltaY < 0 ? 1.08 : .92)));
  updateGraphTransform();
}, { passive: false });
graph.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".node, .edge-group")) return;
  dragStart = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
  graph.setPointerCapture(event.pointerId);
  graph.classList.add("dragging");
});
graph.addEventListener("pointermove", (event) => {
  if (!dragStart) return;
  const rect = graph.getBoundingClientRect();
  state.panX = dragStart.panX + (event.clientX - dragStart.x) * 960 / rect.width;
  state.panY = dragStart.panY + (event.clientY - dragStart.y) * 720 / rect.height;
  updateGraphTransform();
});
function endGraphDrag() { dragStart = null; graph.classList.remove("dragging"); }
graph.addEventListener("pointerup", endGraphDrag);
graph.addEventListener("pointercancel", endGraphDrag);

showView("conexiones");
loadBooks();
