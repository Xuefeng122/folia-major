// src/utils/unhandledRejectionGuard.ts
//
// 一条没人 catch 的 Promise，在 WebKit 里会以 `unhandledrejection` 落到控制台；真机日志里它长得一样、
// 一行接一行，把真正要看的那几行淹掉（bootstrap:104:8901 那一串就是这么来的）。
//
// 这里不是把错误藏起来，而是把它收成一条带原因的 warn，并且同一个原因一个会话只说一次：一个请求在
// 超时之后自己失败，说一次就够，说十五次只说明没人看日志。真正的错误仍然打出来（warn 级别），
// 由此不再被 WebKit 当成未处理错误反复上报。

const said = new Set<string>();

/** 一句话说完这个理由：错误取 message，别的东西取它的字符串本身。 */
const reasonOf = (reason: unknown): string => {
    if (reason instanceof Error) return reason.message || reason.name;
    if (typeof reason === 'string') return reason;
    try {
        return JSON.stringify(reason).slice(0, 200);
    } catch {
        return String(reason);
    }
};

export const installUnhandledRejectionGuard = (): void => {
    if (typeof window === 'undefined') return;
    window.addEventListener('unhandledrejection', event => {
        const reason = reasonOf(event.reason);
        const key = reason.slice(0, 160);
        // 收下它：同一件事已经有人说过一次了，不必让运行环境再报告一遍。
        event.preventDefault();
        if (said.has(key)) return;
        said.add(key);
        console.warn(`[Unhandled] a promise nobody caught failed (said once): ${reason}`);
    });
};
