import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/proxy/index";

const server = createServer(0);
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

describe("static UI routes", () => {
  test("GET / serves the child-session index page", async () => {
    const response = await fetch(`${base}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Grow — занятие");
    expect(html).toContain('src="./app.js"');
  });

  test("GET /console serves the parent console page", async () => {
    const response = await fetch(`${base}/console`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("консоль родителя");
    expect(html).toContain('src="/console/console.js"');
  });

  test("GET /app.js and /console/console.js serve ES modules", async () => {
    const app = await fetch(`${base}/app.js`);
    const consoleModule = await fetch(`${base}/console/console.js`);

    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("text/javascript");
    expect(await app.text()).toContain('from "./proxy-client.js"');
    expect(consoleModule.status).toBe(200);
    expect(consoleModule.headers.get("content-type")).toContain("text/javascript");
  });

  test("GET /style.css and /console/style.css serve the shared stylesheet", async () => {
    const root = await fetch(`${base}/style.css`);
    const consoleRoute = await fetch(`${base}/console/style.css`);

    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/css");
    expect(consoleRoute.status).toBe(200);
    expect(await consoleRoute.text()).toBe(await (await fetch(`${base}/style.css`)).text());
  });

  test("the obsolete /probe page is gone", async () => {
    const response = await fetch(`${base}/probe`);

    expect(response.status).toBe(404);
  });
});
