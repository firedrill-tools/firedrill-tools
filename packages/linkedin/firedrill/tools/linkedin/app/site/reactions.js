// The six reaction types with their product labels, colours and badge glyphs (original simple paths).
const NS = "http://www.w3.org/2000/svg";

export const REACTIONS = [
  { type: "LIKE", label: "Like", colour: "#378fe9", verb: "Like",
    d: "M11.6 7.1H9.3l.4-2.3c.1-.7-.3-1.4-1-1.5h-.3L6 6.6V12h4.6c.5 0 .9-.3 1-.8l.7-3c.1-.6-.3-1.1-.7-1.1zM4 6.6H3.3v5.4H5V6.6z" },
  { type: "PRAISE", label: "Celebrate", colour: "#6dae4f", verb: "Celebrate",
    d: "M6.3 3.5l.6 1.8M9.7 3.5l-.6 1.8M8 2.8v1.9M4.6 7.4l2.8-1.6 1.1 1.2 1.9-.8 1.8 2.8-1.2 3.3H7.2L4.3 9.4c-.4-.4-.3-1.1.3-2z" },
  { type: "APPRECIATION", label: "Support", colour: "#a872e8", verb: "Support",
    d: "M8 4.9c.6-1.1 2.6-1.2 2.9.3.2 1-.8 2-2.9 3.3-2.1-1.3-3.1-2.3-2.9-3.3.3-1.5 2.3-1.4 2.9-.3zM3.2 9.2l1.8-.5 2.4 1h2.2c.5 0 .7.6.3.9l-.6.2h-2l3.4.1 1.8-1.2c.4-.2.8.3.5.6l-2.4 2.2H6.2L3.2 12z" },
  { type: "EMPATHY", label: "Love", colour: "#df704d", verb: "Love",
    d: "M8 12.5S3 9.6 3 6.3C3 4.9 4.1 3.8 5.4 3.8c1.1 0 2 .6 2.6 1.5.6-.9 1.5-1.5 2.6-1.5 1.3 0 2.4 1.1 2.4 2.5 0 3.3-5 6.2-5 6.2z" },
  { type: "INTEREST", label: "Insightful", colour: "#f5bb5c", verb: "Insightful",
    d: "M8 2.8a3.6 3.6 0 00-2.2 6.4c.4.3.6.8.6 1.3v.4h3.2v-.4c0-.5.2-1 .6-1.3A3.6 3.6 0 008 2.8zM6.4 11.7h3.2v.8c0 .4-.4.8-.8.8H7.2c-.4 0-.8-.4-.8-.8z" },
  { type: "ENTERTAINMENT", label: "Funny", colour: "#44bfd3", verb: "Funny",
    d: "M8 2.9a5.1 5.1 0 100 10.2A5.1 5.1 0 008 2.9zM6.1 5.6a.8.8 0 110 1.6.8.8 0 010-1.6zm3.8 0a.8.8 0 110 1.6.8.8 0 010-1.6zM4.9 8.6h6.2A3.2 3.2 0 018 11.4a3.2 3.2 0 01-3.1-2.8z" },
];
export const REACTION_BY_TYPE = new Map(REACTIONS.map((r) => [r.type, r]));

/** A coloured circular badge (size px) for a reaction type. */
export function reactionBadge(type, size = 16) {
  const reaction = REACTION_BY_TYPE.get(type) ?? REACTIONS[0];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", `reaction-badge reaction-badge--${reaction.type.toLowerCase()}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", reaction.label);
  const circle = document.createElementNS(NS, "circle");
  circle.setAttribute("cx", "8");
  circle.setAttribute("cy", "8");
  circle.setAttribute("r", "8");
  circle.setAttribute("fill", reaction.colour);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", reaction.d);
  if (reaction.type === "PRAISE") {
    path.setAttribute("fill", "#fff");
    path.setAttribute("stroke", "#fff");
    path.setAttribute("stroke-width", "0.9");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
  } else path.setAttribute("fill", reaction.type === "INTEREST" ? "#6b3e00" : "#fff");
  svg.append(circle, path);
  return svg;
}
