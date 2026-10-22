import { useEffect, useState } from "react";

export type Route =
  | { name: "articles" }
  | { name: "editor"; id: string }
  | { name: "records" }
  | { name: "accounts" }
  | { name: "me" };

const UUID = /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function parseRoute(pathname: string): Route {
  const [, first, second] = pathname.split("/");
  if (first === "articles" && second && UUID.test(second)) return { name: "editor", id: second };
  if (first === "records") return { name: "records" };
  if (first === "accounts") return { name: "accounts" };
  if (first === "me") return { name: "me" };
  return { name: "articles" };
}

export function routePath(route: Route) {
  return route.name === "editor" ? `/articles/${route.id}` : route.name === "articles" ? "/" : `/${route.name}`;
}

const listeners = new Set<() => void>();
// 导航前的拦截器，用于编辑页未保存内容提醒；返回 false 取消导航。
let guard: (() => Promise<boolean>) | null = null;

export function setNavigationGuard(next: (() => Promise<boolean>) | null) { guard = next; }

export async function navigate(route: Route, replace = false) {
  if (guard && !(await guard())) return;
  const path = routePath(route);
  if (path !== window.location.pathname) history[replace ? "replaceState" : "pushState"](null, "", path);
  listeners.forEach(listener => listener());
  window.scrollTo(0, 0);
}

/** 无依赖的小路由：支持深链与浏览器后退。 */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.pathname));
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => { listeners.delete(update); window.removeEventListener("popstate", update); };
  }, []);
  return route;
}

/** 站内链接：保留中键／新标签页行为，普通点击走客户端导航。 */
export function linkProps(route: Route) {
  return {
    href: routePath(route),
    onClick: (event: React.MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void navigate(route);
    },
  };
}
