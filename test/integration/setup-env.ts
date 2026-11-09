/**
 * Importado PRIMEIRO em cada teste de integração: ajusta o ambiente antes de qualquer módulo
 * da aplicação (ex.: o cliente SQS lê AWS_ENDPOINT ao ser carregado).
 */
process.env.TEST_DATABASE_URL ??= "postgres://wagering:wagering@127.0.0.1:5432/wagering_test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AWS_ENDPOINT ??= "http://127.0.0.1:4566";
// Ambientes com proxy HTTP: chamadas locais (LocalStack/instâncias) não passam por ele.
process.env.NO_PROXY = process.env.no_proxy = ["127.0.0.1", "localhost", process.env.NO_PROXY].filter(Boolean).join(",");
