// 替换 src/routes/index.js 里的 /receive 路由为下面这段
router.post('/receive', async (context) => {
  const { request, env, authPayload } = context;

  await env.TEMP_MAIL_DB.prepare(
    `INSERT INTO debug_events (stage, detail) VALUES (?, ?)`
  ).bind(
    'receive_enter',
    'worker triggered'
  ).run();

  if (authPayload === false) {
    await env.TEMP_MAIL_DB.prepare(
      `INSERT INTO debug_events (stage, detail) VALUES (?, ?)`
    ).bind(
      'receive_unauthorized',
      'authPayload === false'
    ).run();

    return new Response('Unauthorized', { status: 401 });
  }

  let DB;
  try {
    DB = await getDatabaseWithValidation(env);

    await env.TEMP_MAIL_DB.prepare(
      `INSERT INTO debug_events (stage, detail) VALUES (?, ?)`
    ).bind(
      'receive_db_ok',
      'database connected'
    ).run();
  } catch (error) {
    await env.TEMP_MAIL_DB.prepare(
      `INSERT INTO debug_events (stage, detail) VALUES (?, ?)`
    ).bind(
      'receive_db_error',
      String(error && error.stack ? error.stack : error)
    ).run();

    console.error('邮件接收时数据库连接失败:', error.message);
    return new Response('数据库连接失败', { status: 500 });
  }

  try {
    await env.TEMP_MAIL_DB.prepare(
      `INSERT INTO debug_events (stage, detail) VALUES (?, ?)`
    ).bind(
      'receive_before_handler',
      'calling handleEmailReceive'
    ).run();

    return await handleEmailReceive(request, DB, env);
  } catch (error) {
    await env.TEMP_MAIL_DB.prepare(
      `INSERT INTO debug_events (stage, detail) VALUES (?, ?)`
    ).bind(
      'receive_handler_error',
      String(error && error.stack ? error.stack : error)
    ).run();

    throw error;
  }
});

/**
 * 委托API请求到处理器
 * @param {object} context - 请求上下文
 * @returns {Promise<Response>} HTTP响应
 */
