import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";

/**
 * Ponto de extensão da autenticação (seção 2 do desafio: não vale pontos, decisão documentada).
 *
 * Hoje: no-op (deixa passar). Desenho proposto: Keycloak no Docker Compose emitindo tokens OIDC
 * via client_credentials, um client por provedor. Este guard validaria o JWT (JWKS do Keycloak)
 * e conferiria que o claim do provedor no token é igual ao `providerId` do payload/rota.
 * Health checks não usam o guard; mensagens da fila são canal interno confiável, mas o
 * providerId da mensagem continua passando pelas mesmas validações de domínio.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
