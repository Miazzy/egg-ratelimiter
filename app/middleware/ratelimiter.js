"use strict";

const Limiter = require("ratelimiter");
const ms = require("ms");
const debug = require('debug')('egg-ratelimiter');

async function thenify(fn) {
    return await new Promise((resolve, reject) => {
        function callback(err, res) {
            if (err)
                return reject(err);
            return resolve(res);
        }
        fn(callback);
    });
}

function findKeyIndex(routers = [], path) {
    if (routers && Array.isArray(routers)) {
        if (routers.indexOf(path) !== -1) {
            return routers.indexOf(path);
        }
        const index = routers.findIndex((item, index) => {
            if (item === path) {
                return true;
            }
            if (item.endsWith('/**') && path.startsWith(item.slice(0, -2))) {
                return true;
            }
            if (item.endsWith('^') && path.startsWith(item.slice(0, -1))) {
                return true;
            }
        });
        console.log('index:' + index);
        return index;
    }
}


module.exports = (opts = {}) => {
    const { remaining = 'X-RateLimit-Remaining', reset = 'X-RateLimit-Reset', total = 'X-RateLimit-Limit' } = opts.headers || {};
    let actionKeys = [];
    opts.router.forEach(item => actionKeys.push(item.path));
    return async(ctx, next) => {
        // 如果没有限制配置，则直接返回
        if (actionKeys.length === 0)
            return await next();
        // 如果当前访问URL 路径不在actionKeys中 则直接返回
        if (findKeyIndex(actionKeys, ctx.url) === -1)
            return await next();
        //通过ips获取 nginx代理层真实IP，需要配置 config.proxy = true;
        const ips = ctx.ips.length > 0 ? ctx.ips[0] !== '127.0.0.1' ? ctx.ips[0] : ctx.ips[1] : ctx.ip;
        const opt = opts.router[findKeyIndex(actionKeys, ctx.url)]; //请求路径['/']
        opt.duration = ms(opt.time);
        const id = ips;
        if (id == null)
            return await next();
        // initialize limiter
        const limiter = new Limiter(Object.assign({}, opt, { id: `${id}:${ctx.url}`, db: opts.db || ctx.app.redis }));
        // check limit
        const limit = await thenify(limiter.get.bind(limiter));
        // check if current call is legit
        const calls = limit.remaining > 0 ? limit.remaining - 1 : 0;
        // header fields
        const headers = {
            [remaining]: calls,
            [reset]: limit.reset,
            [total]: limit.total
        };
        ctx.set(headers);
        debug('remaining %s/%s %s', calls, limit.total, id);
        if (limit.remaining)
            return await next();
        const delta = (limit.reset * 1000 - Date.now()) | 0;
        const after = (limit.reset - Date.now() / 1000) | 0;
        ctx.set('Retry-After', after);
        ctx.status = 429;
        ctx.body = opt.message || `Rate limit exceeded, retry in ${ms(delta, { long: true })}.`;
        if (opts.throw) {
            ctx.throw(ctx.status, ctx.body, {
                headers
            });
        }
    };
};